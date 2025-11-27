// gmail-handler.js - Gmail API Handler para ALEX
// Maneja OAuth, lectura de correos y sincronización de alertas bancarias

class GmailHandler {
    constructor(supabaseClient) {
        this.supabase = supabaseClient;
        this.SCOPES = [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile'
        ];
        this.DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest';
        this.CLIENT_ID = '671066486744-sa69btkqhorlnhed02pbtho60kbebn8r.apps.googleusercontent.com';
        this.gapiInitialized = false;
        this.gisInitialized = false;
        this.tokenClient = null;
    }

    // Inicializar Google API
    async initializeGoogleAPI() {
        return new Promise((resolve, reject) => {
            // Cargar gapi
            const gapiScript = document.createElement('script');
            gapiScript.src = 'https://apis.google.com/js/api.js';
            gapiScript.onload = () => {
                gapi.load('client', async () => {
                    await gapi.client.init({
                        discoveryDocs: [this.DISCOVERY_DOC]
                    });
                    this.gapiInitialized = true;
                    console.log('GAPI initialized');
                    
                    // Cargar GIS (Google Identity Services)
                    const gisScript = document.createElement('script');
                    gisScript.src = 'https://accounts.google.com/gsi/client';
                    gisScript.onload = () => {
                        this.tokenClient = google.accounts.oauth2.initTokenClient({
                            client_id: this.CLIENT_ID,
                            scope: this.SCOPES.join(' '),
                            callback: '', // Se define en requestGmailAccess
                        });
                        this.gisInitialized = true;
                        console.log('GIS initialized');
                        resolve();
                    };
                    gisScript.onerror = reject;
                    document.head.appendChild(gisScript);
                });
            };
            gapiScript.onerror = reject;
            document.head.appendChild(gapiScript);
        });
    }

    // Solicitar acceso a Gmail (OAuth)
    async requestGmailAccess() {
        if (!this.gapiInitialized || !this.gisInitialized) {
            await this.initializeGoogleAPI();
        }

        return new Promise((resolve, reject) => {
            this.tokenClient.callback = async (response) => {
                if (response.error !== undefined) {
                    reject(response);
                    return;
                }

                // Obtener información del usuario
                const userInfo = await this.getUserInfo();
                
                // Guardar en Supabase
                const saved = await this.saveConnectedEmail(userInfo.email, response.access_token);
                
                if (saved) {
                    resolve({
                        email: userInfo.email,
                        accessToken: response.access_token
                    });
                } else {
                    reject(new Error('Failed to save email connection'));
                }
            };

            this.tokenClient.requestAccessToken({ prompt: 'consent' });
        });
    }

    // Obtener información del usuario de Google
    async getUserInfo() {
        try {
            const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: {
                    Authorization: `Bearer ${gapi.client.getToken().access_token}`
                }
            });
            return await response.json();
        } catch (error) {
            console.error('Error getting user info:', error);
            throw error;
        }
    }

    // Guardar correo conectado en Supabase
    async saveConnectedEmail(email, accessToken) {
        try {
            const { data: { user } } = await this.supabase.auth.getUser();
            
            if (!user) {
                throw new Error('User not authenticated');
            }

            const { data, error } = await this.supabase
                .from('connected_emails')
                .upsert({
                    user_id: user.id,
                    email: email,
                    access_token: accessToken, // En producción, deberías encriptar esto
                    token_expires_at: new Date(Date.now() + 3600000).toISOString(), // 1 hora
                    is_active: true,
                    last_sync_at: new Date().toISOString()
                }, {
                    onConflict: 'user_id,email'
                });

            if (error) throw error;
            
            console.log('Email connection saved:', email);
            return true;
        } catch (error) {
            console.error('Error saving connected email:', error);
            return false;
        }
    }

    // Leer mensajes de Gmail
    async getMessages(email, query = '', maxResults = 50) {
        try {
            // Obtener access token de Supabase
            const { data: { user } } = await this.supabase.auth.getUser();
            const { data: emailData } = await this.supabase
                .from('connected_emails')
                .select('access_token')
                .eq('user_id', user.id)
                .eq('email', email)
                .single();

            if (!emailData || !emailData.access_token) {
                throw new Error('No access token found for this email');
            }

            // Configurar token
            gapi.client.setToken({ access_token: emailData.access_token });

            // Buscar mensajes
            const response = await gapi.client.gmail.users.messages.list({
                userId: 'me',
                q: query,
                maxResults: maxResults
            });

            return response.result.messages || [];
        } catch (error) {
            console.error('Error getting messages:', error);
            throw error;
        }
    }

    // Leer un mensaje específico
    async getMessage(email, messageId) {
        try {
            const { data: { user } } = await this.supabase.auth.getUser();
            const { data: emailData } = await this.supabase
                .from('connected_emails')
                .select('access_token')
                .eq('user_id', user.id)
                .eq('email', email)
                .single();

            if (!emailData || !emailData.access_token) {
                throw new Error('No access token found for this email');
            }

            gapi.client.setToken({ access_token: emailData.access_token });

            const response = await gapi.client.gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'full'
            });

            return response.result;
        } catch (error) {
            console.error('Error getting message:', error);
            throw error;
        }
    }

    // Sincronizar alertas bancarias
    async syncBankAlerts(email) {
        try {
            console.log(`Syncing bank alerts for ${email}...`);

            // Queries para cada banco
            const queries = [
                'from:alertasynotificaciones@an.notificacionesbancolombia.com OR from:notificaciones@bancolombia.com.co',
                'from:noreply@nequi.com.co OR from:notificaciones@nequi.com.co',
                'from:daviplata@davivienda.com OR from:noreply@davivienda.com'
            ];

            let allTransactions = [];

            for (const query of queries) {
                const messages = await this.getMessages(email, query, 20);
                
                for (const message of messages) {
                    const fullMessage = await this.getMessage(email, message.id);
                    const parsed = await this.parseMessage(fullMessage);
                    
                    if (parsed) {
                        allTransactions.push(parsed);
                    }
                }
            }

            // Guardar transacciones en Supabase
            if (allTransactions.length > 0) {
                await this.saveTransactions(allTransactions);
            }

            // Actualizar last_sync_at
            const { data: { user } } = await this.supabase.auth.getUser();
            await this.supabase
                .from('connected_emails')
                .update({ last_sync_at: new Date().toISOString() })
                .eq('user_id', user.id)
                .eq('email', email);

            console.log(`Synced ${allTransactions.length} transactions`);
            return allTransactions.length;
        } catch (error) {
            console.error('Error syncing bank alerts:', error);
            throw error;
        }
    }

    // Parsear mensaje (delegamos a BankParsers)
    async parseMessage(message) {
        // Asumiendo que BankParsers está cargado globalmente
        if (typeof BankParsers !== 'undefined') {
            return BankParsers.parseMessage(message);
        }
        return null;
    }

    // Guardar transacciones en Supabase
    async saveTransactions(transactions) {
        try {
            const { data: { user } } = await this.supabase.auth.getUser();
            
            const transactionsWithUser = transactions.map(t => ({
                ...t,
                user_id: user.id,
                created_at: new Date().toISOString()
            }));

            const { error } = await this.supabase
                .from('transactions')
                .upsert(transactionsWithUser, {
                    onConflict: 'user_id,date,amount,bank' // Evitar duplicados
                });

            if (error) throw error;
            
            console.log(`Saved ${transactions.length} transactions`);
            return true;
        } catch (error) {
            console.error('Error saving transactions:', error);
            return false;
        }
    }

    // Obtener correos conectados
    async getConnectedEmails() {
        try {
            const { data: { user } } = await this.supabase.auth.getUser();
            
            const { data, error } = await this.supabase
                .from('connected_emails')
                .select('*')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false });

            if (error) throw error;
            
            return data || [];
        } catch (error) {
            console.error('Error getting connected emails:', error);
            return [];
        }
    }
}

// Exportar
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GmailHandler;
}
