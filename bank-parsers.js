// bank-parsers.js - Parsers para alertas bancarias
// Extrae información de correos de Bancolombia, Nequi y Daviplata

class BankParsers {
    
    // Identificar banco desde el mensaje
    static identifyBank(message) {
        const from = this.getHeader(message, 'From')?.toLowerCase() || '';
        
        if (from.includes('bancolombia')) return 'Bancolombia';
        if (from.includes('nequi')) return 'Nequi';
        if (from.includes('daviplata') || from.includes('davivienda')) return 'Daviplata';
        
        return null;
    }

    // Obtener header del mensaje
    static getHeader(message, headerName) {
        const headers = message.payload?.headers || [];
        const header = headers.find(h => h.name === headerName);
        return header?.value || null;
    }

    // Obtener cuerpo del mensaje
    static getBody(message) {
        let body = '';
        
        if (message.payload?.body?.data) {
            body = atob(message.payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
        } else if (message.payload?.parts) {
            for (const part of message.payload.parts) {
                if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
                    if (part.body?.data) {
                        body += atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
                    }
                }
            }
        }
        
        return body;
    }

    // Parsear mensaje completo
    static parseMessage(message) {
        const bank = this.identifyBank(message);
        
        if (!bank) return null;

        const body = this.getBody(message);
        const subject = this.getHeader(message, 'Subject');
        const date = this.getHeader(message, 'Date');

        let parsed = null;

        switch (bank) {
            case 'Bancolombia':
                parsed = this.parseBancolombia(body, subject, date);
                break;
            case 'Nequi':
                parsed = this.parseNequi(body, subject, date);
                break;
            case 'Daviplata':
                parsed = this.parseDaviplata(body, subject, date);
                break;
        }

        if (parsed) {
            parsed.bank = bank;
            parsed.message_id = message.id;
        }

        return parsed;
    }

    // Parser para Bancolombia
    static parseBancolombia(body, subject, date) {
        try {
            // Detectar tipo de transacción
            let type = 'expense';
            if (subject?.toLowerCase().includes('recibiste') || 
                subject?.toLowerCase().includes('consignación') ||
                body.toLowerCase().includes('recibiste')) {
                type = 'income';
            }

            // Extraer monto
            const amountMatch = body.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
            if (!amountMatch) return null;
            
            const amount = parseFloat(amountMatch[1].replace(/,/g, ''));

            // Extraer descripción
            let description = 'Transacción Bancolombia';
            
            // Intentar extraer desde el asunto
            if (subject) {
                if (subject.includes('Compra')) {
                    description = 'Compra con tarjeta';
                } else if (subject.includes('Retiro')) {
                    description = 'Retiro en cajero';
                } else if (subject.includes('Transferencia')) {
                    description = 'Transferencia';
                } else {
                    description = subject;
                }
            }

            // Extraer categoría
            const category = this.categorizeTransaction(description, type);

            return {
                type,
                amount,
                description: description.substring(0, 200), // Límite de caracteres
                category,
                date: new Date(date).toISOString()
            };
        } catch (error) {
            console.error('Error parsing Bancolombia:', error);
            return null;
        }
    }

    // Parser para Nequi
    static parseNequi(body, subject, date) {
        try {
            // Detectar tipo
            let type = 'expense';
            if (body.toLowerCase().includes('recibiste') || 
                body.toLowerCase().includes('te enviaron') ||
                subject?.toLowerCase().includes('recibiste')) {
                type = 'income';
            }

            // Extraer monto
            const amountMatch = body.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
            if (!amountMatch) return null;
            
            const amount = parseFloat(amountMatch[1].replace(/,/g, ''));

            // Extraer descripción
            let description = 'Transacción Nequi';
            
            if (subject) {
                description = subject;
            } else if (body.includes('enviaste')) {
                description = 'Envío de dinero';
            } else if (body.includes('recibiste')) {
                description = 'Recibo de dinero';
            } else if (body.includes('pago')) {
                description = 'Pago';
            }

            // Extraer nombre de quien envió/recibió
            const nameMatch = body.match(/(?:enviaste|recibiste|de|para)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i);
            if (nameMatch) {
                description = `${type === 'income' ? 'De' : 'Para'} ${nameMatch[1]}`;
            }

            const category = this.categorizeTransaction(description, type);

            return {
                type,
                amount,
                description: description.substring(0, 200),
                category,
                date: new Date(date).toISOString()
            };
        } catch (error) {
            console.error('Error parsing Nequi:', error);
            return null;
        }
    }

    // Parser para Daviplata
    static parseDaviplata(body, subject, date) {
        try {
            // Detectar tipo
            let type = 'expense';
            if (body.toLowerCase().includes('recibiste') || 
                body.toLowerCase().includes('consignación') ||
                subject?.toLowerCase().includes('recibiste')) {
                type = 'income';
            }

            // Extraer monto
            const amountMatch = body.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
            if (!amountMatch) return null;
            
            const amount = parseFloat(amountMatch[1].replace(/,/g, ''));

            // Extraer descripción
            let description = 'Transacción Daviplata';
            
            if (subject) {
                description = subject;
            } else if (body.includes('retiro')) {
                description = 'Retiro de dinero';
            } else if (body.includes('pago')) {
                description = 'Pago';
            }

            const category = this.categorizeTransaction(description, type);

            return {
                type,
                amount,
                description: description.substring(0, 200),
                category,
                date: new Date(date).toISOString()
            };
        } catch (error) {
            console.error('Error parsing Daviplata:', error);
            return null;
        }
    }

    // Categorizar transacción automáticamente
    static categorizeTransaction(description, type) {
        const desc = description.toLowerCase();

        if (type === 'income') {
            if (desc.includes('salario') || desc.includes('nómina')) return 'Salario';
            if (desc.includes('freelance') || desc.includes('trabajo')) return 'Ingresos extra';
            return 'Ingresos';
        }

        // Categorías para gastos
        if (desc.includes('mercado') || desc.includes('supermercado') || desc.includes('tienda')) {
            return 'Alimentación';
        }
        if (desc.includes('arriendo') || desc.includes('alquiler') || desc.includes('renta')) {
            return 'Vivienda';
        }
        if (desc.includes('transporte') || desc.includes('uber') || desc.includes('taxi') || desc.includes('gasolina')) {
            return 'Transporte';
        }
        if (desc.includes('restaurante') || desc.includes('comida') || desc.includes('domicilio')) {
            return 'Alimentación';
        }
        if (desc.includes('servicio') || desc.includes('luz') || desc.includes('agua') || desc.includes('gas') || desc.includes('internet')) {
            return 'Servicios';
        }
        if (desc.includes('salud') || desc.includes('médico') || desc.includes('farmacia') || desc.includes('hospital')) {
            return 'Salud';
        }
        if (desc.includes('entretenimiento') || desc.includes('cine') || desc.includes('netflix') || desc.includes('spotify')) {
            return 'Entretenimiento';
        }

        return 'Otros';
    }

    // Extraer múltiples transacciones de un mensaje (algunos correos tienen múltiples alertas)
    static parseMultipleTransactions(message) {
        const bank = this.identifyBank(message);
        if (!bank) return [];

        const body = this.getBody(message);
        const date = this.getHeader(message, 'Date');

        // Buscar múltiples montos en el mensaje
        const amountMatches = [...body.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)/g)];
        
        if (amountMatches.length <= 1) {
            // Solo una transacción, usar parser normal
            const parsed = this.parseMessage(message);
            return parsed ? [parsed] : [];
        }

        // Múltiples transacciones
        const transactions = [];
        
        for (const match of amountMatches) {
            const amount = parseFloat(match[1].replace(/,/g, ''));
            
            transactions.push({
                type: 'expense', // Por defecto
                amount,
                description: `Transacción ${bank}`,
                category: 'Otros',
                bank,
                date: new Date(date).toISOString(),
                message_id: message.id
            });
        }

        return transactions;
    }
}

// Exportar
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BankParsers;
}
