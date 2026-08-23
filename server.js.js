// ============================================================
//  SERVER DI AURA MENTOR - COMPLETO (CORRETTO)
//  - Fingerprint collegato realmente al controllo anti-frode
//  - Codice genitore con scadenza e invalidazione dopo l'uso
//  - Dashboard genitori protetta da token di accesso
//  - Cache che tiene conto della modalità
//  - Gestione errori Supabase corretta (niente .catch() silenziosi)
//  - NUOVO: /api/foto-to-text per leggere testo dalle foto (OpenAI)
// ============================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Necessario se il server è dietro un proxy/load balancer (es. Scaleway):
// senza questo, req.ip restituisce l'IP del proxy invece di quello reale del client.
app.set('trust proxy', true);

// ============================================================
//  CONFIGURAZIONE
// ============================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const SCALEWAY_API_KEY = process.env.DEEPSEEK_API_KEY;

const SCALEWAY_BASE_URL = 'https://api.scaleway.ai/v1';
const SCALEWAY_MODEL = process.env.SCALEWAY_MODEL || 'deepseek-v4-flash';

// NUOVO: configurazione OpenAI per la lettura delle foto (foto -> testo)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';

// NUOVO: configurazione Revolut Business (pagamenti genitori)
// Vanno configurate su .env quando l'account Revolut Business è pronto:
// REVOLUT_SECRET_KEY, REVOLUT_WEBHOOK_SECRET, REVOLUT_PLAN_BASE_ID, REVOLUT_PLAN_PRO_ID
const REVOLUT_SECRET_KEY = process.env.REVOLUT_SECRET_KEY;
const REVOLUT_WEBHOOK_SECRET = process.env.REVOLUT_WEBHOOK_SECRET;
const REVOLUT_BASE_URL = process.env.REVOLUT_BASE_URL || 'https://merchant.revolut.com/api';
const REVOLUT_PLAN_BASE_ID = process.env.REVOLUT_PLAN_BASE_ID;
const REVOLUT_PLAN_PRO_ID = process.env.REVOLUT_PLAN_PRO_ID;
// Dove atterra il genitore dopo il pagamento (pagina web statica, non su questo server)
const LANDING_PAGE_URL = process.env.LANDING_PAGE_URL || 'https://TUO-DOMINIO/attiva';

// NUOVO: canale opzionale per avvisarvi di segnali di rischio rilevati (Slack/Telegram/Discord
// webhook in stile "incoming webhook" che accetta { text: '...' } o { content: '...' }).
// Se non configurato, l'avviso viene solo loggato in console.
const ADMIN_ALERT_WEBHOOK_URL = process.env.ADMIN_ALERT_WEBHOOK_URL;

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['*'];

// ============================================================
//  COSTANTI
// ============================================================
const LIMITE_MESSAGGI_GRATIS = 10; // prova gratuita: tutto sbloccato, incluse le foto
const LIMITE_BASE_TESTO_GIORNALIERO = 15;
const LIMITE_PRO_TESTO_GIORNALIERO = 35;
const LIMITE_PRO_FOTO_GIORNALIERO = 15; // il Base non ha accesso alle foto: nessun limite da definire
const LIMITE_ASSOLUTO_GIORNALIERO = 50; // tetto di sicurezza "fair usage", indipendente dal piano
const MAX_LEN_MESSAGGIO = 4000;
const MAX_LEN_NOME_PROF = 30;

// Ordine mostrato nell'app. "richiedeFoto" = va quasi sempre insieme a una foto
// (usato solo per UI/telemetria, il server non lo applica direttamente).
// "soloPro" = bloccata con lucchetto per prova-gratuita-esaurita e piano Base.
const MODALITA_INFO = {
    spiegami_concetto: { soloPro: false },
    aiuto_compiti: { soloPro: false },
    interrogami: { soloPro: false },
    ripasso: { soloPro: false },
    correggi_compito: { soloPro: true },
    scanner_brutti_voti: { soloPro: true },
};
const MODALITA_VALIDE = Object.keys(MODALITA_INFO);
const MODALITA_SOLO_PRO = MODALITA_VALIDE.filter(m => MODALITA_INFO[m].soloPro);

const CACHE_SCADENZA_GIORNI = 30;
const CODICE_ACCOPPIAMENTO_SCADENZA_MINUTI = 30;
// NUOVO: limite dimensione immagine in base64 (~5MB di immagine originale)
const MAX_LEN_IMMAGINE_BASE64 = 7 * 1024 * 1024;
// Quanti scambi (coppie domanda/risposta) di memoria si mandano all'AI
const MEMORIA_NUMERO_MESSAGGI = 6;

// ============================================================
//  SICUREZZA STUDENTI: RILEVAMENTO SEGNALI DI RISCHIO
//  Controllo a livello di parole chiave, volutamente semplice: in caso di
//  dubbio è meglio un falso positivo (l'AI mostra comunque le risorse di
//  aiuto ed evita di continuare come se nulla fosse) che un falso negativo.
// ============================================================
const PAROLE_CHIAVE_RISCHIO = [
    'suicid', 'ammazzarmi', 'ammazzo', 'farla finita', 'non voglio più vivere',
    'non voglio più stare al mondo', 'tagliarmi', 'tagliuzzarmi', 'autolesion',
    'uccidermi', 'togliermi la vita', 'non ce la faccio più a vivere',
    'meglio se non ci fossi', 'voglio sparire per sempre', 'farmi del male',
];

const MESSAGGIO_RISORSE_EMERGENZA = `Mi sembra che tu stia passando un momento davvero difficile, e voglio che tu sappia che non sei solo/a. Parlarne con qualcuno può aiutare tantissimo.

Puoi contattare gratuitamente e in modo confidenziale:
📞 **Telefono Amico Italia**: 02 2327 2327 (tutti i giorni, anche via chat su telefonoamico.it)
📞 **Telefono Azzurro**: 19696 (attivo 24 ore su 24, per bambini e adolescenti)
🚨 **Emergenza**: 112

Se vuoi, prova a parlarne anche con un adulto di cui ti fidi — un genitore, un insegnante, chiunque ti faccia sentire al sicuro. Sono qui anche solo per ascoltare, quando vuoi.`;

function contieneSegnaliDiRischio(testo) {
    if (typeof testo !== 'string') return false;
    const normalizzato = testo.toLowerCase();
    return PAROLE_CHIAVE_RISCHIO.some(parola => normalizzato.includes(parola));
}

async function avvisaAdminRischio(deviceId) {
    console.error(`🚨 SEGNALE DI RISCHIO rilevato per device ${deviceId} alle ${new Date().toISOString()}`);
    if (!ADMIN_ALERT_WEBHOOK_URL) return;
    try {
        await fetch(ADMIN_ALERT_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: `🚨 Aura Mentor: segnale di rischio rilevato per il dispositivo ${deviceId} — controllare al più presto.`,
            }),
        });
    } catch (error) {
        console.error('❌ Errore invio avviso admin:', error.message);
    }
}

// ============================================================
//  CLIENT
// ============================================================
if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ SUPABASE_URL o SUPABASE_KEY mancanti nel .env');
}
if (!SCALEWAY_API_KEY) {
    console.error('❌ DEEPSEEK_API_KEY mancante nel .env');
}
if (!OPENAI_API_KEY) {
    console.warn('⚠️ OPENAI_API_KEY mancante nel .env: la funzione foto->testo non funzionerà.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================
//  MIDDLEWARE
// ============================================================
app.use(cors({
    origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
}));
app.use(express.json({ limit: '10mb' }));

// ============================================================
//  HOME
// ============================================================
app.get('/', (req, res) => {
    res.send(`
        <h1 style="color: #9b59b6;">🚀 Aura Mentor Server</h1>
        <p style="font-size: 18px; color: #333;">Server attivo su Scaleway!</p>
        <p style="font-size: 14px; color: #666;">Modello: <strong>DeepSeek V4 Flash</strong></p>
        <p style="font-size: 14px; color: #666;">Funzionalità: <strong>Chat + Fingerprint + Cache + Dashboard Genitori + Limiti Giornalieri + Foto-to-Text</strong></p>
        <hr>
        <p style="font-size: 12px; color: #999;">Aura Mentor v2.2 - Chivasso, Italia 🇮🇹</p>
    `);
});

// ============================================================
//  UTILITY: HASH E TOKEN
// ============================================================
function calcolaHash(testo) {
    return crypto.createHash('sha256').update(testo).digest('hex');
}

function generaTokenSicuro(byteLength = 24) {
    return crypto.randomBytes(byteLength).toString('hex');
}

// ============================================================
//  FUNZIONE: VALIDAZIONE INPUT
// ============================================================
function validaInput({ messaggioStudente, nomeProf, modalita }) {
    if (typeof messaggioStudente !== 'string' || messaggioStudente.trim().length === 0) {
        return 'Il messaggio dello studente è obbligatorio.';
    }
    if (messaggioStudente.length > MAX_LEN_MESSAGGIO) {
        return `Il messaggio supera la lunghezza massima di ${MAX_LEN_MESSAGGIO} caratteri.`;
    }
    if (nomeProf !== undefined && nomeProf !== null) {
        if (typeof nomeProf !== 'string' || nomeProf.length > MAX_LEN_NOME_PROF) {
            return 'Nome del prof non valido.';
        }
    }
    if (modalita !== undefined && modalita !== null) {
        if (!MODALITA_VALIDE.includes(modalita)) {
            return 'Modalità non valida.';
        }
    }
    return null;
}

// ============================================================
//  ISTRUZIONI PER OGNI MODALITÀ
// ============================================================
const ISTRUZIONI_MODALITA = {
    spiegami_concetto: 'Lo studente ti chiede di spiegare un concetto che non ha capito. Spiegalo in modo semplice e diretto, con un esempio concreto o un\'analogia della vita reale, evitando paroloni inutili.',
    aiuto_compiti: 'Lo studente ha un esercizio da risolvere e vuole essere guidato, non la soluzione bella e pronta. Usa il metodo socratico: fai domande e dai indizi mirati, un passo alla volta, così arriva alla soluzione da solo.',
    interrogami: 'Agisci come un professore che sta interrogando: fai una domanda alla volta sull\'argomento, aspetta la risposta, valutala brevemente, poi passa alla successiva. Dopo alcune domande, dai un voto orientativo (in decimi) e un consiglio su cosa ripassare. Se dai un voto, scrivilo sempre in questo formato esatto in una riga a parte: [VOTO_PREDITTIVO: X.X] seguito da una breve nota (es. "Pronto per la verifica di domani").',
    ripasso: 'Fai un ripasso interattivo dell\'argomento portato dallo studente: spiega i concetti chiave in modo chiaro, con esempi pratici e concreti, poi chiudi con 2-3 domande veloci per verificare che abbia capito.',
    correggi_compito: 'Lo studente ti mostra un compito o un esercizio già svolto (anche fotografato). Correggilo: dì chiaramente cosa è giusto, cosa è sbagliato e perché, e mostra come si risolve correttamente il punto sbagliato.',
    scanner_brutti_voti: 'Lo studente ti mostra una verifica andata male (di solito fotografata). Analizza gli errori commessi, spiega brevemente perché sono sbagliati, poi crea esattamente 3 esercizi mirati per allenarsi proprio su quei punti deboli, numerati e chiari.',
};

function nomeModalita(modalita) {
    const nomi = {
        spiegami_concetto: 'Spiegazione concetto',
        aiuto_compiti: 'Aiuto compiti',
        interrogami: 'Interrogazione',
        ripasso: 'Ripasso',
        correggi_compito: 'Correzione compito',
        scanner_brutti_voti: 'Scanner brutti voti',
    };
    return nomi[modalita] || 'Generale';
}

// ============================================================
//  FUNZIONE: CHIAMATA SCALEWAY
// ============================================================
async function chiamataScaleway(messaggio, modalita, nomeProf, storicoMessaggi) {
    try {
        const istruzioniModalita = ISTRUZIONI_MODALITA[modalita] || ISTRUZIONI_MODALITA.spiegami_concetto;
        const nomeTutor = (nomeProf && nomeProf.trim()) ? nomeProf.trim() : 'Aura Mentor';

        const systemPrompt = `Sei ${nomeTutor}, un tutor scolastico personale per studenti delle medie/superiori.

Modalità attiva: ${nomeModalita(modalita)}.
${istruzioniModalita}

Stile: sii amichevole, diretto e un po' brillante — MAI noioso o ripetitivo. Varia il modo in cui apri le risposte (non iniziare sempre allo stesso modo), usa un tono naturale come parlerebbe un tutor giovane e in gamba, e ogni tanto anche un pizzico di ironia leggera se il momento lo permette. Rispondi sempre in italiano, con frasi brevi e chiare. Usa elenchi puntati e grassetti per i concetti chiave, ma senza esagerare con la formattazione.`;

        console.log('📤 Chiamata a Scaleway...');

        const messages = [{ role: 'system', content: systemPrompt }];

        // Aggiungiamo gli ultimi scambi (memoria conversazione), se presenti,
        // così l'AI segue il filo del discorso invece di ripartire da zero
        // ad ogni messaggio.
        if (Array.isArray(storicoMessaggi)) {
            for (const m of storicoMessaggi) {
                if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
                    messages.push({ role: m.role, content: m.content });
                }
            }
        }

        messages.push({ role: 'user', content: messaggio });

        const response = await fetch(`${SCALEWAY_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SCALEWAY_API_KEY}`,
            },
            body: JSON.stringify({
                model: SCALEWAY_MODEL,
                messages,
                max_tokens: 1500,
                temperature: 0.85,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Errore HTTP:', response.status, errorText);
            return { ok: false, testo: 'ERRORE: Impossibile elaborare la richiesta. Riprova più tardi.' };
        }

        const data = await response.json();

        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            console.error('❌ Risposta Scaleway malformata:', JSON.stringify(data));
            return { ok: false, testo: 'ERRORE: Risposta non valida dal servizio AI.' };
        }

        console.log('✅ Risposta ricevuta!');
        return { ok: true, testo: data.choices[0].message.content };

    } catch (error) {
        console.error('❌ Errore Scaleway:', error.message);
        return { ok: false, testo: 'ERRORE: Impossibile elaborare la richiesta. Riprova più tardi.' };
    }
}

// ============================================================
//  NUOVA FUNZIONE: CHIAMATA OPENAI PER LETTURA FOTO (VISION)
// ============================================================
async function chiamataOpenAIVisione(imageBase64, mimeType) {
    try {
        console.log('📤 Chiamata a OpenAI (foto->testo)...');

        const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: OPENAI_VISION_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: 'Trascrivi fedelmente il testo visibile nell\'immagine (es. esercizio, domanda, appunti). Se non c\'è testo ma un problema visivo (es. un grafico, una figura geometrica), descrivi brevemente cosa serve per rispondere. Rispondi in italiano, solo con il contenuto utile, senza commenti aggiuntivi.'
                    },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Estrai il testo o descrivi il problema in questa immagine:' },
                            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
                        ]
                    }
                ],
                max_tokens: 800,
                temperature: 0.2,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Errore HTTP OpenAI:', response.status, errorText);
            return { ok: false, testo: 'ERRORE: Impossibile leggere l\'immagine. Riprova più tardi.' };
        }

        const data = await response.json();

        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            console.error('❌ Risposta OpenAI malformata:', JSON.stringify(data));
            return { ok: false, testo: 'ERRORE: Risposta non valida dal servizio di lettura immagini.' };
        }

        console.log('✅ Testo estratto dalla foto!');
        return { ok: true, testo: data.choices[0].message.content };

    } catch (error) {
        console.error('❌ Errore OpenAI Vision:', error.message);
        return { ok: false, testo: 'ERRORE: Impossibile elaborare l\'immagine. Riprova più tardi.' };
    }
}

// ============================================================
//  FUNZIONE: CONTROLLA FINGERPRINT (usata anche da /api/chat)
//  Restituisce { bloccato: bool, motivo?: string }
// ============================================================
async function controllaFingerprint(deviceId, fingerprintHash) {
    if (!fingerprintHash) {
        // Nessun fingerprint fornito: non blocchiamo la richiesta (potrebbe
        // essere un client che non lo supporta), ma logghiamo per visibilità.
        console.warn('⚠️ Nessun fingerprintHash fornito per', deviceId);
        return { bloccato: false };
    }

    const { data: esistente, error } = await supabase
        .from('fingerprints')
        .select('device_id')
        .eq('fingerprint_hash', fingerprintHash)
        .maybeSingle();

    if (error) {
        console.error('❌ Errore lettura fingerprint:', error);
        // In caso di errore di lettura non blocchiamo l'utente per un problema
        // infrastrutturale nostro, ma logghiamo.
        return { bloccato: false };
    }

    if (esistente && esistente.device_id !== deviceId) {
        const { error: insertFrodeError } = await supabase
            .from('segnalazioni_frode')
            .insert({
                device_id_attuale: deviceId,
                device_id_originale: esistente.device_id,
                fingerprint_hash: fingerprintHash,
                tentativo: 'cambio_device_id'
            });

        if (insertFrodeError) {
            console.error('❌ Errore salvataggio segnalazione frode:', insertFrodeError);
        }

        return {
            bloccato: true,
            motivo: 'Questo dispositivo è già stato utilizzato. I messaggi gratuiti non sono disponibili.'
        };
    }

    // Aggiorna/registra il fingerprint per questo device
    const { error: upsertError } = await supabase
        .from('fingerprints')
        .upsert({
            device_id: deviceId,
            fingerprint_hash: fingerprintHash,
            last_seen: new Date().toISOString()
        }, { onConflict: 'device_id' });

    if (upsertError) {
        console.error('❌ Errore upsert fingerprint:', upsertError);
    }

    return { bloccato: false };
}

// ============================================================
//  NUOVA FUNZIONE CONDIVISA: TROVA/CREA UTENTE
// ============================================================
async function trovaOCreaUtente(deviceId, req) {
    let { data: utente, error: fetchError } = await supabase
        .from('users')
        .select('*')
        .eq('device_id', deviceId)
        .maybeSingle();

    if (fetchError) {
        return { ok: false, statusCode: 500, body: { error: 'Errore lettura dati utente' } };
    }

    if (!utente) {
        console.log('🆕 Creazione utente:', deviceId);
        const { data: nuovoUtente, error: insertError } = await supabase
            .from('users')
            .upsert({
                device_id: deviceId,
                messaggi_gratis_inviati: 0,
                is_vip: false,
                tipo_abbonamento: 'free',
                ip_registrazione: req.ip || 'unknown'
            }, { onConflict: 'device_id' })
            .select()
            .single();

        if (insertError) {
            return { ok: false, statusCode: 500, body: { error: 'Errore creazione utente' } };
        }
        utente = nuovoUtente;
    }

    return { ok: true, utente };
}

// ============================================================
//  NUOVA FUNZIONE CONDIVISA: AUTORIZZA E CONSUMA UN MESSAGGIO
//  Usata sia da /api/chat che da /api/foto-to-text.
//
//  options.tipo: 'testo' | 'foto' — determina quale contatore giornaliero
//  si applica per gli utenti abbonati (Base: solo testo 15/giorno;
//  Pro: testo 35/giorno E foto 15/giorno, contatori indipendenti).
//  options.modalita: se appartiene a MODALITA_SOLO_PRO, blocca il Base
//  (durante la prova gratuita invece è tutto sbloccato, foto comprese).
//
//  Ritorna:
//   { ok:true, utente, haAbbonamento, messaggiRimanenti, vip }
//   { ok:false, statusCode, body }
// ============================================================
async function autorizzaEConsumaMessaggio(deviceId, fingerprintHash, req, options = {}) {
    const tipo = options.tipo === 'foto' ? 'foto' : 'testo';
    const modalita = options.modalita || null;

    const risultatoUtente = await trovaOCreaUtente(deviceId, req);
    if (!risultatoUtente.ok) return risultatoUtente;

    let utente = risultatoUtente.utente;

    // VIP: nessun controllo, nessun consumo, nessun lucchetto.
    if (utente.is_vip) {
        return { ok: true, utente, haAbbonamento: true, messaggiRimanenti: -1, vip: true };
    }

    const haAbbonamentoPreliminare = utente.tipo_abbonamento !== 'free'
        && utente.scadenza_abbonamento
        && new Date(utente.scadenza_abbonamento) > new Date();

    // ============================================================
    //  CASO 1: PROVA GRATUITA (nessun abbonamento attivo)
    //  Tutto sbloccato, incluse foto e modalità "solo Pro": è la vetrina
    //  per far vedere tutto il potenziale prima di scegliere un piano.
    // ============================================================
    if (!haAbbonamentoPreliminare) {
        const esitoFingerprint = await controllaFingerprint(deviceId, fingerprintHash);
        if (esitoFingerprint.bloccato) {
            return {
                ok: false,
                statusCode: 403,
                body: { status: 'BLOCCATO', messaggio: esitoFingerprint.motivo }
            };
        }

        if (utente.messaggi_gratis_inviati >= LIMITE_MESSAGGI_GRATIS) {
            return {
                ok: false,
                statusCode: 403,
                body: {
                    status: 'BLOCCATO',
                    messaggio: `Hai esaurito i ${LIMITE_MESSAGGI_GRATIS} messaggi gratuiti! Mostra questa schermata ai tuoi genitori.`,
                    messaggiRimanenti: 0
                }
            };
        }

        const { data: righeAggiornate, error: updateError } = await supabase
            .from('users')
            .update({ messaggi_gratis_inviati: utente.messaggi_gratis_inviati + 1 })
            .eq('device_id', deviceId)
            .lt('messaggi_gratis_inviati', LIMITE_MESSAGGI_GRATIS)
            .select();

        if (updateError) {
            return { ok: false, statusCode: 500, body: { error: 'Errore aggiornamento contatore messaggi' } };
        }
        if (!righeAggiornate || righeAggiornate.length === 0) {
            return {
                ok: false,
                statusCode: 403,
                body: {
                    status: 'BLOCCATO',
                    messaggio: `Hai esaurito i ${LIMITE_MESSAGGI_GRATIS} messaggi gratuiti!`,
                    messaggiRimanenti: 0
                }
            };
        }

        utente.messaggi_gratis_inviati += 1;
        const messaggiRimanenti = LIMITE_MESSAGGI_GRATIS - utente.messaggi_gratis_inviati;
        return { ok: true, utente, haAbbonamento: false, messaggiRimanenti };
    }

    // ============================================================
    //  CASO 2: ABBONATO (Base o Pro)
    // ============================================================
    const haAbbonamento = haAbbonamentoPreliminare;
    const pianoAttuale = utente.tipo_abbonamento;

    // Lucchetto sulle modalità/foto riservate al Pro
    const modalitaBloccata = modalita && MODALITA_SOLO_PRO.includes(modalita);
    if (pianoAttuale === 'base' && (tipo === 'foto' || modalitaBloccata)) {
        return {
            ok: false,
            statusCode: 403,
            body: {
                status: 'SOLO_PRO',
                messaggio: 'Questa funzione è disponibile solo con il piano Pro.'
            }
        };
    }

    // Tetto di sicurezza assoluto: protegge da bug/abusi indipendentemente dal piano.
    const oggi = new Date().toISOString().split('T')[0];
    const { count: totaleOggi, error: countTotaleError } = await supabase
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('device_id', deviceId)
        .eq('role', 'user')
        .gte('created_at', oggi);

    if (countTotaleError) {
        console.error('❌ Errore conteggio totale giornaliero:', countTotaleError);
    } else if (totaleOggi >= LIMITE_ASSOLUTO_GIORNALIERO) {
        return {
            ok: false,
            statusCode: 429,
            body: {
                status: 'PAUSA_CAFFE',
                messaggio: 'Ehi! Il tuo Tutor si sta prendendo un caffè per ricaricare le batterie ☕ Torna tra qualche ora per continuare a studiare!',
                messaggiRimanenti: 0
            }
        };
    }

    // Limite giornaliero specifico per piano + tipo (testo o foto)
    let limiteGiornaliero;
    if (tipo === 'foto') {
        limiteGiornaliero = LIMITE_PRO_FOTO_GIORNALIERO; // il Base è già bloccato sopra
    } else {
        limiteGiornaliero = pianoAttuale === 'pro' ? LIMITE_PRO_TESTO_GIORNALIERO : LIMITE_BASE_TESTO_GIORNALIERO;
    }

    const { count: contoTipoOggi, error: countTipoError } = await supabase
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('device_id', deviceId)
        .eq('role', 'user')
        .eq('tipo', tipo)
        .gte('created_at', oggi);

    if (countTipoError) {
        console.error('❌ Errore conteggio giornaliero per tipo:', countTipoError);
    } else if (contoTipoOggi >= limiteGiornaliero) {
        if (tipo === 'testo' && pianoAttuale === 'base') {
            return {
                ok: false,
                statusCode: 429,
                body: {
                    status: 'LIMITE_GIORNALIERO_UPSELL',
                    messaggio: 'Hai dato il massimo oggi! 🎉 Con il piano Pro hai la possibilità di continuare a studiare, più la possibilità di fotografare i tuoi esercizi. Vuoi dare un\'occhiata?',
                    messaggiRimanenti: 0,
                    limite: limiteGiornaliero,
                }
            };
        }
        return {
            ok: false,
            statusCode: 429,
            body: {
                status: 'LIMITE_GIORNALIERO',
                messaggio: `Hai raggiunto il limite giornaliero del piano ${pianoAttuale === 'pro' ? 'Pro' : 'Base'}. Torna domani!`,
                messaggiRimanenti: 0,
                limite: limiteGiornaliero,
            }
        };
    }

    return { ok: true, utente, haAbbonamento: true, messaggiRimanenti: -1 };
}

// ============================================================
//  API: REGISTRA FINGERPRINT (chiamata esplicita, es. all'avvio app)
// ============================================================
app.post('/api/registra-fingerprint', async (req, res) => {
    const { deviceId, fingerprint } = req.body;

    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'deviceId mancante o non valido' });
    }
    if (!fingerprint || typeof fingerprint !== 'object') {
        return res.status(400).json({ error: 'fingerprint mancante o non valido' });
    }

    const fingerprintHash = calcolaHash(JSON.stringify(fingerprint));

    try {
        const { data: esistente, error: fetchError } = await supabase
            .from('fingerprints')
            .select('device_id')
            .eq('fingerprint_hash', fingerprintHash)
            .maybeSingle();

        if (fetchError) {
            console.error('❌ Errore lettura fingerprint:', fetchError);
            return res.status(500).json({ error: 'Errore interno' });
        }

        if (esistente && esistente.device_id !== deviceId) {
            const { error: insertFrodeError } = await supabase
                .from('segnalazioni_frode')
                .insert({
                    device_id_attuale: deviceId,
                    device_id_originale: esistente.device_id,
                    fingerprint_hash: fingerprintHash,
                    tentativo: 'cambio_device_id'
                });

            if (insertFrodeError) {
                console.error('❌ Errore salvataggio segnalazione frode:', insertFrodeError);
            }

            return res.status(403).json({
                status: 'BLOCCATO',
                messaggio: 'Questo dispositivo è già stato utilizzato. I messaggi gratuiti non sono disponibili.'
            });
        }

        const { error: upsertError } = await supabase
            .from('fingerprints')
            .upsert({
                device_id: deviceId,
                fingerprint_hash: fingerprintHash,
                fingerprint_dati: fingerprint,
                ip_address: req.ip || 'unknown',
                last_seen: new Date().toISOString()
            }, { onConflict: 'device_id' });

        if (upsertError) {
            console.error('❌ Errore salvataggio fingerprint:', upsertError);
            return res.status(500).json({ error: 'Errore interno' });
        }

        // Restituiamo anche l'hash: il client lo può inviare a /api/chat
        // così il controllo anti-frode è applicato ad ogni messaggio, non
        // solo alla registrazione iniziale.
        res.json({ status: 'OK', messaggio: 'Fingerprint registrato', fingerprintHash });

    } catch (error) {
        console.error('❌ Errore fingerprint:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ============================================================
//  API: GENERA CODICE GENITORE (con scadenza)
// ============================================================
app.post('/api/genera-codice', async (req, res) => {
    const { deviceId } = req.body;

    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'deviceId mancante o non valido' });
    }

    const caratteri = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let codice = '';
    for (let i = 0; i < 6; i++) {
        codice += caratteri.charAt(Math.floor(Math.random() * caratteri.length));
    }
    const codiceCompleto = `AM-${codice}`;

    try {
        const { error } = await supabase
            .from('users')
            .update({
                codice_accoppiamento: codiceCompleto,
                codice_generato_il: new Date().toISOString()
            })
            .eq('device_id', deviceId);

        if (error) {
            console.error('❌ Errore generazione codice:', error);
            return res.status(500).json({ error: 'Errore interno' });
        }

        res.json({
            codice: codiceCompleto,
            scadeTraMinuti: CODICE_ACCOPPIAMENTO_SCADENZA_MINUTI
        });
    } catch (error) {
        console.error('❌ Errore generazione codice:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ============================================================
//  API: ACCOPPIA GENITORE (con controllo scadenza + invalidazione)
// ============================================================
// ============================================================
//  FUNZIONE CONDIVISA: ATTIVA L'ABBONAMENTO SU UN DEVICE
//  Usata sia da /api/accoppia-genitore (flusso manuale/test, SENZA verifica
//  di pagamento reale — da usare solo per debug admin) sia dal webhook di
//  Revolut dopo un pagamento confermato (flusso reale).
// ============================================================
async function attivaAbbonamentoGenitore({ deviceId, emailGenitore, telefonoGenitore, pianoScelto }) {
    const dashboardToken = generaTokenSicuro();

    const { error: insertGenitoreError } = await supabase
        .from('genitori')
        .insert({
            email_genitore: emailGenitore,
            telefono_genitore: telefonoGenitore || null,
            device_id_figlio: deviceId,
            piano_attivo: pianoScelto,
            dashboard_token: dashboardToken
        });

    if (insertGenitoreError) {
        return { ok: false, errore: insertGenitoreError };
    }

    const scadenza = new Date();
    scadenza.setMonth(scadenza.getMonth() + 1);

    const { error: updateUserError } = await supabase
        .from('users')
        .update({
            tipo_abbonamento: pianoScelto,
            scadenza_abbonamento: scadenza.toISOString(),
            codice_accoppiamento: null,
            codice_generato_il: null
        })
        .eq('device_id', deviceId);

    if (updateUserError) {
        return { ok: false, errore: updateUserError };
    }

    return { ok: true, dashboardToken };
}

app.post('/api/accoppia-genitore', async (req, res) => {
    const { emailGenitore, codiceInserito, pianoScelto } = req.body;

    if (!emailGenitore || typeof emailGenitore !== 'string') {
        return res.status(400).json({ error: 'emailGenitore mancante o non valida' });
    }
    if (!codiceInserito || typeof codiceInserito !== 'string') {
        return res.status(400).json({ error: 'codiceInserito mancante o non valido' });
    }
    if (!pianoScelto || !['base', 'pro'].includes(pianoScelto)) {
        return res.status(400).json({ error: 'pianoScelto non valido (deve essere "base" o "pro")' });
    }

    try {
        const { data: utente, error: fetchError } = await supabase
            .from('users')
            .select('device_id, codice_generato_il')
            .eq('codice_accoppiamento', codiceInserito)
            .maybeSingle();

        if (fetchError) {
            console.error('❌ Errore lettura codice:', fetchError);
            return res.status(500).json({ error: 'Errore interno' });
        }

        if (!utente) {
            return res.status(404).json({ error: 'Codice non valido o scaduto' });
        }

        // Controllo scadenza codice
        if (utente.codice_generato_il) {
            const minutiPassati = (new Date() - new Date(utente.codice_generato_il)) / (1000 * 60);
            if (minutiPassati > CODICE_ACCOPPIAMENTO_SCADENZA_MINUTI) {
                await supabase
                    .from('users')
                    .update({ codice_accoppiamento: null })
                    .eq('device_id', utente.device_id);

                return res.status(410).json({ error: 'Codice scaduto. Generane uno nuovo dall\'app.' });
            }
        }

        const risultato = await attivaAbbonamentoGenitore({
            deviceId: utente.device_id,
            emailGenitore,
            pianoScelto,
        });

        if (!risultato.ok) {
            console.error('❌ Errore attivazione abbonamento (manuale):', risultato.errore);
            return res.status(500).json({ error: 'Errore interno' });
        }

        res.json({
            success: true,
            messaggio: 'Abbonamento attivato!',
            dashboardToken: risultato.dashboardToken
        });

    } catch (error) {
        console.error('❌ Errore accoppiamento:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ============================================================
//  NUOVA API: CREA ORDINE DI PAGAMENTO (avvia il checkout Revolut)
//  Chiamata dalla landing page quando il genitore sceglie un piano.
//  Crea un ordine "in sospeso" e rimanda a Revolut per il pagamento vero:
//  l'abbonamento NON viene attivato qui, solo dopo conferma via webhook.
//
//  ⚠️ RICHIEDE che tu abbia già configurato REVOLUT_SECRET_KEY,
//  REVOLUT_PLAN_BASE_ID e REVOLUT_PLAN_PRO_ID nel file .env (li ottieni
//  dal pannello Revolut Business dopo aver creato i due piani).
// ============================================================
app.post('/api/crea-ordine-pagamento', async (req, res) => {
    const { codiceInserito, emailGenitore, telefonoGenitore, pianoScelto } = req.body;

    if (!codiceInserito || typeof codiceInserito !== 'string') {
        return res.status(400).json({ error: 'codiceInserito mancante o non valido' });
    }
    if (!emailGenitore || typeof emailGenitore !== 'string') {
        return res.status(400).json({ error: 'emailGenitore mancante o non valida' });
    }
    if (!pianoScelto || !['base', 'pro'].includes(pianoScelto)) {
        return res.status(400).json({ error: 'pianoScelto non valido' });
    }
    if (!REVOLUT_SECRET_KEY || !REVOLUT_PLAN_BASE_ID || !REVOLUT_PLAN_PRO_ID) {
        console.error('❌ Revolut non configurato: mancano REVOLUT_SECRET_KEY o gli ID dei piani nel .env');
        return res.status(503).json({ error: 'Pagamenti non ancora disponibili. Riprova più tardi.' });
    }

    try {
        const { data: utente, error: fetchError } = await supabase
            .from('users')
            .select('device_id, codice_generato_il')
            .eq('codice_accoppiamento', codiceInserito)
            .maybeSingle();

        if (fetchError) {
            console.error('❌ Errore lettura codice:', fetchError);
            return res.status(500).json({ error: 'Errore interno' });
        }
        if (!utente) {
            return res.status(404).json({ error: 'Codice non valido o scaduto' });
        }
        if (utente.codice_generato_il) {
            const minutiPassati = (new Date() - new Date(utente.codice_generato_il)) / (1000 * 60);
            if (minutiPassati > CODICE_ACCOPPIAMENTO_SCADENZA_MINUTI) {
                return res.status(410).json({ error: 'Codice scaduto. Chiedi a tuo figlio di generarne uno nuovo.' });
            }
        }

        const idOrdine = generaTokenSicuro(12);

        const { error: insertOrdineError } = await supabase
            .from('ordini_pendenti')
            .insert({
                id: idOrdine,
                device_id: utente.device_id,
                email_genitore: emailGenitore,
                telefono_genitore: telefonoGenitore || null,
                piano_scelto: pianoScelto,
                stato: 'in_attesa',
            });

        if (insertOrdineError) {
            console.error('❌ Errore creazione ordine pendente:', insertOrdineError);
            return res.status(500).json({ error: 'Errore interno' });
        }

        const planId = pianoScelto === 'pro' ? REVOLUT_PLAN_PRO_ID : REVOLUT_PLAN_BASE_ID;

        // Chiamata all'API Subscriptions di Revolut per creare l'abbonamento
        // e ottenere l'URL della pagina di pagamento ospitata. La forma esatta
        // della richiesta va verificata sulla documentazione Revolut al
        // momento dell'integrazione reale (developer.revolut.com/docs/merchant/subscriptions):
        // questo è un punto di partenza corretto nella struttura, da testare
        // con le tue chiavi vere prima di andare in produzione.
        const revolutResponse = await fetch(`${REVOLUT_BASE_URL}/subscriptions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${REVOLUT_SECRET_KEY}`,
            },
            body: JSON.stringify({
                plan_id: planId,
                metadata: { ordine_id: idOrdine },
                redirect_url: `${LANDING_PAGE_URL}/successo?ordine=${idOrdine}`,
            }),
        });

        if (!revolutResponse.ok) {
            const errorText = await revolutResponse.text();
            console.error('❌ Errore creazione abbonamento Revolut:', revolutResponse.status, errorText);
            return res.status(502).json({ error: 'Impossibile avviare il pagamento. Riprova più tardi.' });
        }

        const datiRevolut = await revolutResponse.json();

        res.json({
            success: true,
            ordineId: idOrdine,
            // Il nome esatto del campo con l'URL di checkout va confermato
            // dalla risposta reale di Revolut quando testi con le tue chiavi.
            checkoutUrl: datiRevolut.checkout_url || datiRevolut.hosted_page_url || null,
        });

    } catch (error) {
        console.error('❌ Errore crea-ordine-pagamento:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ============================================================
//  NUOVA API: WEBHOOK REVOLUT (conferma pagamento -> attiva abbonamento)
//  Revolut chiama QUESTO endpoint quando un pagamento va a buon fine.
//  Non fidarti mai di un webhook senza verificarne l'autenticità: qui va
//  verificata la firma con REVOLUT_WEBHOOK_SECRET secondo la documentazione
//  ufficiale (il nome esatto dell'header/algoritmo va confermato quando
//  configuri il webhook nel pannello Revolut).
// ============================================================
app.post('/api/webhook-revolut', async (req, res) => {
    if (!REVOLUT_WEBHOOK_SECRET) {
        console.error('❌ Webhook Revolut ricevuto ma REVOLUT_WEBHOOK_SECRET non configurato: rifiutato.');
        return res.status(503).json({ error: 'Webhook non configurato' });
    }

    // TODO quando configuri Revolut: verificare qui la firma della richiesta
    // (header tipo 'Revolut-Signature') con crypto.createHmac usando
    // REVOLUT_WEBHOOK_SECRET, prima di fidarsi del contenuto del body.

    const evento = req.body;
    const tipoEvento = evento?.event;
    const ordineId = evento?.data?.metadata?.ordine_id || evento?.metadata?.ordine_id;

    if (!ordineId) {
        console.warn('⚠️ Webhook Revolut senza ordine_id nei metadata, ignorato.');
        return res.status(200).json({ ricevuto: true });
    }

    if (tipoEvento !== 'ORDER_COMPLETED' && tipoEvento !== 'SUBSCRIPTION_ACTIVATED') {
        // Altri eventi (pagamento fallito, ecc.): logghiamo e basta per ora.
        console.log(`ℹ️ Webhook Revolut ricevuto: ${tipoEvento} per ordine ${ordineId}`);
        return res.status(200).json({ ricevuto: true });
    }

    try {
        const { data: ordine, error: fetchOrdineError } = await supabase
            .from('ordini_pendenti')
            .select('*')
            .eq('id', ordineId)
            .maybeSingle();

        if (fetchOrdineError || !ordine) {
            console.error('❌ Ordine pendente non trovato per webhook:', ordineId);
            return res.status(200).json({ ricevuto: true }); // 200 comunque, per non far ritentare Revolut all'infinito
        }

        if (ordine.stato === 'completato') {
            // Webhook duplicato (Revolut può reinviarlo): non riattiviamo due volte.
            return res.status(200).json({ ricevuto: true });
        }

        const risultato = await attivaAbbonamentoGenitore({
            deviceId: ordine.device_id,
            emailGenitore: ordine.email_genitore,
            telefonoGenitore: ordine.telefono_genitore,
            pianoScelto: ordine.piano_scelto,
        });

        if (!risultato.ok) {
            console.error('❌ Errore attivazione abbonamento da webhook:', risultato.errore);
            return res.status(500).json({ error: 'Errore interno' });
        }

        await supabase
            .from('ordini_pendenti')
            .update({ stato: 'completato', dashboard_token: risultato.dashboardToken })
            .eq('id', ordineId);

        console.log(`✅ Abbonamento attivato via Revolut per device ${ordine.device_id}`);
        res.status(200).json({ ricevuto: true });

    } catch (error) {
        console.error('❌ Errore webhook Revolut:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ============================================================
//  NUOVA API: STATO ORDINE (la landing page fa polling dopo il redirect
//  di ritorno da Revolut, per mostrare "pagamento confermato" e il link
//  alla dashboard non appena il webhook ha fatto il suo lavoro)
// ============================================================
app.get('/api/stato-ordine/:ordineId', async (req, res) => {
    const { ordineId } = req.params;

    const { data: ordine, error } = await supabase
        .from('ordini_pendenti')
        .select('stato, dashboard_token')
        .eq('id', ordineId)
        .maybeSingle();

    if (error || !ordine) {
        return res.status(404).json({ error: 'Ordine non trovato' });
    }

    res.json({
        stato: ordine.stato,
        dashboardToken: ordine.stato === 'completato' ? ordine.dashboard_token : null,
    });
});

// ============================================================
//  NUOVA API: STATO SBLOCCO (l'app sul telefono dello studente fa
//  polling su questo endpoint mentre è ferma sulla schermata di blocco,
//  per sbloccarsi da sola non appena il genitore ha pagato)
// ============================================================
app.get('/api/stato-sblocco', async (req, res) => {
    const { deviceId } = req.query;

    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'deviceId mancante o non valido' });
    }

    const { data: utente, error } = await supabase
        .from('users')
        .select('tipo_abbonamento, scadenza_abbonamento, is_vip')
        .eq('device_id', deviceId)
        .maybeSingle();

    if (error || !utente) {
        return res.status(404).json({ error: 'Utente non trovato' });
    }

    const sbloccato = utente.is_vip || (
        utente.tipo_abbonamento !== 'free'
        && utente.scadenza_abbonamento
        && new Date(utente.scadenza_abbonamento) > new Date()
    );

    res.json({ sbloccato, tipoAbbonamento: utente.tipo_abbonamento });
});

// ============================================================
//  API: DASHBOARD GENITORE (protetta da token)
//  Il genitore deve fornire email + dashboardToken ricevuto
//  al momento dell'accoppiamento. Senza token corretto, niente dati.
// ============================================================
app.post('/api/dashboard-genitore', async (req, res) => {
    const { emailGenitore, dashboardToken } = req.body;

    if (!emailGenitore || typeof emailGenitore !== 'string') {
        return res.status(400).json({ error: 'emailGenitore mancante o non valida' });
    }
    if (!dashboardToken || typeof dashboardToken !== 'string') {
        return res.status(401).json({ error: 'Token di accesso mancante' });
    }

    try {
        const { data: collegamento, error: fetchError } = await supabase
            .from('genitori')
            .select('device_id_figlio, piano_attivo, dashboard_token')
            .eq('email_genitore', emailGenitore)
            .maybeSingle();

        if (fetchError) {
            console.error('❌ Errore lettura collegamento genitore:', fetchError);
            return res.status(500).json({ error: 'Errore interno' });
        }

        if (!collegamento) {
            return res.status(404).json({ error: 'Nessun figlio associato a questa email' });
        }

        // Confronto a tempo costante per evitare timing attack sul token
        const tokenValido = collegamento.dashboard_token
            && dashboardToken.length === collegamento.dashboard_token.length
            && crypto.timingSafeEqual(
                Buffer.from(dashboardToken),
                Buffer.from(collegamento.dashboard_token)
            );

        if (!tokenValido) {
            return res.status(403).json({ error: 'Token di accesso non valido' });
        }

        // Ultimi 500 messaggi (arco di analisi ragionevole senza appesantire troppo la query)
        const { data: stats, error: statsError } = await supabase
            .from('chat_messages')
            .select('role, created_at, tipo, modalita, voto_predittivo')
            .eq('device_id', collegamento.device_id_figlio)
            .order('created_at', { ascending: false })
            .limit(500);

        if (statsError) {
            console.error('❌ Errore lettura statistiche:', statsError);
        }

        const { data: utente, error: utenteError } = await supabase
            .from('users')
            .select('tipo_abbonamento, scadenza_abbonamento, messaggi_gratis_inviati')
            .eq('device_id', collegamento.device_id_figlio)
            .maybeSingle();

        if (utenteError) {
            console.error('❌ Errore lettura utente per dashboard:', utenteError);
        }

        const pianoAttuale = collegamento.piano_attivo || utente?.tipo_abbonamento || 'free';
        const messaggiUtente = (stats || []).filter(m => m.role === 'user');

        // Stima ore di studio: ogni scambio (domanda + risposta) vale
        // circa 5 minuti di attenzione reale.
        const oreStudio = (messaggiUtente.length * 5 / 60).toFixed(1);

        // Conteggio per modalità (non più per materia)
        const conteggioModalita = {};
        for (const m of messaggiUtente) {
            const chiave = m.modalita || 'altro';
            conteggioModalita[chiave] = (conteggioModalita[chiave] || 0) + 1;
        }

        const simulazioniInterrogazione = messaggiUtente.filter(m => m.modalita === 'interrogami').length;

        // Trend voti predittivi (solo Pro): ultimi voti registrati, dal più vecchio al più recente
        const votiConData = (stats || [])
            .filter(m => m.role === 'assistant' && m.voto_predittivo !== null && m.voto_predittivo !== undefined)
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
            .map(m => ({ data: m.created_at, voto: m.voto_predittivo }));

        const pagellaPredittivaSbloccata = pianoAttuale === 'pro';

        res.json({
            success: true,
            deviceId: collegamento.device_id_figlio,
            piano: pianoAttuale,
            scadenza: utente?.scadenza_abbonamento,
            messaggiUsati: utente?.messaggi_gratis_inviati || 0,
            oreStudio: parseFloat(oreStudio),
            totaleMessaggi: messaggiUtente.length,
            conteggioModalita,
            simulazioniInterrogazione,
            pagellaPredittiva: {
                sbloccata: pagellaPredittivaSbloccata,
                storico: pagellaPredittivaSbloccata ? votiConData : [],
                ultimoVoto: pagellaPredittivaSbloccata && votiConData.length > 0
                    ? votiConData[votiConData.length - 1].voto
                    : null,
            },
            scannerVerificheSbloccato: pianoAttuale === 'pro',
            ruolo: 'genitore'
        });

    } catch (error) {
        console.error('❌ Errore dashboard:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ============================================================
//  NUOVA API: FOTO -> TESTO (usa OpenAI per leggere l'immagine)
//  Riservata al piano Pro (in prova gratuita è comunque disponibile,
//  come assaggio). Consuma un messaggio come una domanda in chat,
//  perché ogni foto è una vera chiamata a pagamento a OpenAI.
// ============================================================
app.post('/api/foto-to-text', async (req, res) => {
    const { deviceId, imageBase64, mimeType, fingerprintHash, modalita } = req.body;

    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'deviceId mancante o non valido' });
    }
    if (!imageBase64 || typeof imageBase64 !== 'string') {
        return res.status(400).json({ error: 'imageBase64 mancante o non valido' });
    }
    if (imageBase64.length > MAX_LEN_IMMAGINE_BASE64) {
        return res.status(400).json({ error: 'Immagine troppo grande. Usa una foto più piccola.' });
    }
    const tipoImmagine = typeof mimeType === 'string' && mimeType.startsWith('image/')
        ? mimeType
        : 'image/jpeg';

    if (!OPENAI_API_KEY) {
        console.error('❌ Tentativo di usare foto-to-text senza OPENAI_API_KEY configurata');
        return res.status(503).json({ error: 'Funzione foto non disponibile al momento.' });
    }

    try {
        const autorizzazione = await autorizzaEConsumaMessaggio(deviceId, fingerprintHash, req, {
            tipo: 'foto',
            modalita: modalita || null,
        });
        if (!autorizzazione.ok) {
            return res.status(autorizzazione.statusCode).json(autorizzazione.body);
        }

        const risultato = await chiamataOpenAIVisione(imageBase64, tipoImmagine);

        if (!risultato.ok) {
            return res.status(502).json({ error: risultato.testo });
        }

        // Registriamo la foto nello storico con tipo='foto', usata sia per il
        // conteggio dei limiti giornalieri sia per le statistiche in dashboard.
        const { error: insertError } = await supabase
            .from('chat_messages')
            .insert([
                { device_id: deviceId, role: 'user', content: '[foto]', tipo: 'foto', modalita: modalita || null },
            ]);
        if (insertError) {
            console.error('⚠️ Errore salvataggio storico foto:', insertError);
        }

        res.json({
            status: 'OK',
            testo: risultato.testo,
            messaggiRimanenti: autorizzazione.messaggiRimanenti
        });

    } catch (error) {
        console.error('❌ Errore foto-to-text:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// ============================================================
//  API: CHAT (PRINCIPALE - CON TUTTE LE FUNZIONALITÀ)
// ============================================================
// ============================================================
//  MEMORIA CONVERSAZIONE: ultimi N messaggi (scambi utente/assistant)
// ============================================================
async function recuperaStorico(deviceId) {
    const { data, error } = await supabase
        .from('chat_messages')
        .select('role, content')
        .eq('device_id', deviceId)
        .in('role', ['user', 'assistant'])
        .order('created_at', { ascending: false })
        .limit(MEMORIA_NUMERO_MESSAGGI);

    if (error) {
        console.error('❌ Errore lettura storico conversazione:', error);
        return [];
    }
    return (data || []).reverse();
}

// Estrae un eventuale voto predittivo scritto dall'AI nel formato
// [VOTO_PREDITTIVO: 7.5] e lo separa dal testo mostrato allo studente.
function estraiVotoPredittivo(testoRisposta) {
    const match = testoRisposta.match(/\[VOTO_PREDITTIVO:\s*([\d.,]+)\]/i);
    if (!match) return { testoPulito: testoRisposta, voto: null };
    const voto = parseFloat(match[1].replace(',', '.'));
    const testoPulito = testoRisposta.replace(match[0], '').trim();
    return { testoPulito, voto: isNaN(voto) ? null : voto };
}

app.post('/api/chat', async (req, res) => {
    const { deviceId, messaggioStudente, nomeProf, modalita, fingerprintHash } = req.body;

    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'deviceId mancante o non valido' });
    }

    const erroreValidazione = validaInput({ messaggioStudente, nomeProf, modalita });
    if (erroreValidazione) {
        return res.status(400).json({ error: erroreValidazione });
    }

    // ============================================================
    //  SICUREZZA: se il messaggio contiene segnali di rischio, blocchiamo
    //  la risposta scolastica normale e mostriamo le risorse di aiuto.
    //  Questo controllo viene PRIMA di consumare qualsiasi quota: la
    //  sicurezza dello studente non deve dipendere da quanti messaggi gli
    //  restano.
    // ============================================================
    if (contieneSegnaliDiRischio(messaggioStudente)) {
        await avvisaAdminRischio(deviceId);
        // Salviamo comunque nello storico (senza il testo esatto in log,
        // ma il messaggio va comunque registrato per contesto clinico se
        // un adulto dovesse mai rivedere la conversazione).
        await supabase.from('chat_messages').insert([
            { device_id: deviceId, role: 'user', content: messaggioStudente, tipo: 'testo', modalita: modalita || null },
            { device_id: deviceId, role: 'assistant', content: MESSAGGIO_RISORSE_EMERGENZA, tipo: 'testo', modalita: modalita || null },
        ]);
        return res.json({
            status: 'RISORSE_SICUREZZA',
            risposta: MESSAGGIO_RISORSE_EMERGENZA,
            messaggiRimanenti: -1,
            daCache: false,
        });
    }

    try {
        const autorizzazione = await autorizzaEConsumaMessaggio(deviceId, fingerprintHash, req, {
            tipo: 'testo',
            modalita: modalita || null,
        });
        if (!autorizzazione.ok) {
            return res.status(autorizzazione.statusCode).json(autorizzazione.body);
        }

        const { utente, haAbbonamento, messaggiRimanenti, vip } = autorizzazione;
        console.log('👤 Utente:', utente.device_id);

        if (vip) {
            console.log('⭐ Utente VIP! Accesso illimitato.');

            const storico = await recuperaStorico(deviceId);
            const risultatoIA = await chiamataScaleway(messaggioStudente, modalita, nomeProf, storico);
            const { testoPulito, voto } = estraiVotoPredittivo(risultatoIA.testo);

            const { error: insertStoricoError } = await supabase
                .from('chat_messages')
                .insert([
                    { device_id: deviceId, role: 'user', content: messaggioStudente, tipo: 'testo', modalita: modalita || null },
                    { device_id: deviceId, role: 'assistant', content: testoPulito, tipo: 'testo', modalita: modalita || null, voto_predittivo: voto }
                ]);

            if (insertStoricoError) {
                console.error('⚠️ Errore salvataggio storico VIP:', insertStoricoError);
            }

            return res.json({
                status: 'OK',
                risposta: testoPulito,
                votoPredittivo: voto,
                messaggiRimanenti: 'VIP',
                daCache: false
            });
        }

        // ============================================================
        //  CONTROLLA CACHE (chiave = modalità + domanda)
        // ============================================================
        const hashDomanda = calcolaHash(`${modalita || ''}|${messaggioStudente}`);
        const { data: rispostaCache, error: cacheReadError } = await supabase
            .from('cache_risposte')
            .select('risposta, created_at')
            .eq('hash', hashDomanda)
            .maybeSingle();

        if (cacheReadError) {
            console.error('❌ Errore lettura cache:', cacheReadError);
        }

        if (rispostaCache) {
            const giorniPassati = (new Date() - new Date(rispostaCache.created_at)) / (1000 * 60 * 60 * 24);
            if (giorniPassati < CACHE_SCADENZA_GIORNI) {
                console.log('📦 Risposta dalla cache!');

                const { error: insertStoricoCacheError } = await supabase
                    .from('chat_messages')
                    .insert([
                        { device_id: deviceId, role: 'user', content: messaggioStudente, tipo: 'testo', modalita: modalita || null },
                        { device_id: deviceId, role: 'assistant', content: rispostaCache.risposta, tipo: 'testo', modalita: modalita || null }
                    ]);

                if (insertStoricoCacheError) {
                    console.error('⚠️ Errore salvataggio storico cache:', insertStoricoCacheError);
                }

                return res.json({
                    status: 'OK',
                    risposta: rispostaCache.risposta,
                    messaggiRimanenti,
                    daCache: true
                });
            }
        }

        // ============================================================
        //  CHIAMA SCALEWAY (con memoria conversazione)
        // ============================================================
        const storico = await recuperaStorico(deviceId);
        const risultatoIA = await chiamataScaleway(messaggioStudente, modalita, nomeProf, storico);
        const { testoPulito, voto } = risultatoIA.ok
            ? estraiVotoPredittivo(risultatoIA.testo)
            : { testoPulito: risultatoIA.testo, voto: null };

        // ============================================================
        //  SALVA IN CACHE (se la risposta è valida)
        // ============================================================
        if (risultatoIA.ok && !testoPulito.includes('ERRORE')) {
            const { error: cacheWriteError } = await supabase
                .from('cache_risposte')
                .upsert({
                    hash: hashDomanda,
                    domanda: messaggioStudente,
                    modalita: modalita || null,
                    risposta: testoPulito
                }, { onConflict: 'hash' });

            if (cacheWriteError) {
                console.error('⚠️ Errore salvataggio cache:', cacheWriteError);
            }
        }

        // ============================================================
        //  SALVA STORICO
        // ============================================================
        const { error: insertStoricoError } = await supabase
            .from('chat_messages')
            .insert([
                { device_id: deviceId, role: 'user', content: messaggioStudente, tipo: 'testo', modalita: modalita || null },
                { device_id: deviceId, role: 'assistant', content: testoPulito, tipo: 'testo', modalita: modalita || null, voto_predittivo: voto }
            ]);

        if (insertStoricoError) {
            console.error('⚠️ Errore salvataggio storico:', insertStoricoError);
        }

        // ============================================================
        //  RISPOSTA
        // ============================================================
        if (!risultatoIA.ok) {
            return res.status(502).json({
                status: 'ERRORE_AI',
                risposta: testoPulito,
                messaggiRimanenti
            });
        }

        return res.json({
            status: 'OK',
            risposta: testoPulito,
            votoPredittivo: voto,
            messaggiRimanenti,
            daCache: false,
            abbonamento: haAbbonamento ? utente.tipo_abbonamento : 'free'
        });

    } catch (error) {
        console.error('❌ Errore chat:', error);
        return res.status(500).json({ error: 'Errore interno del server' });
    }
});

// ============================================================
//  AVVIO
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 Aura Mentor Server attivo su http://localhost:${PORT}`);
    console.log(`🤖 Modello Scaleway: ${SCALEWAY_MODEL} (${SCALEWAY_BASE_URL})`);
    console.log(`🔑 API Key Scaleway: ${SCALEWAY_API_KEY ? '✅ Presente' : '❌ Manca'}`);
    console.log(`🖼️ API Key OpenAI (foto): ${OPENAI_API_KEY ? '✅ Presente' : '❌ Manca'}`);
    console.log(`🔐 Supabase key: ${process.env.SUPABASE_SERVICE_KEY ? 'service_role ✅' : 'anon/altra (verifica RLS!) ⚠️'}`);
    console.log(`🌍 CORS: ${ALLOWED_ORIGINS.includes('*') ? 'Aperto a tutti (solo sviluppo!)' : ALLOWED_ORIGINS.join(', ')}`);
    console.log(`📦 Cache: ${CACHE_SCADENZA_GIORNI} giorni`);
    console.log(`📊 Limiti testo: Base ${LIMITE_BASE_TESTO_GIORNALIERO}/giorno, Pro ${LIMITE_PRO_TESTO_GIORNALIERO}/giorno — Limite foto Pro: ${LIMITE_PRO_FOTO_GIORNALIERO}/giorno`);
    console.log(`👨‍👩‍👧 Codice accoppiamento: scade dopo ${CODICE_ACCOPPIAMENTO_SCADENZA_MINUTI} minuti`);
    console.log(`🌐 Trust proxy: attivo (necessario per rilevare l'IP reale dietro Scaleway)`);
});
