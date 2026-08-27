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
const { google } = require('googleapis'); // per verificare gli acquisti Google Play Billing
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
// Solo per modelli con "reasoning" configurabile (es. gpt-oss-120b): 'low' | 'medium' | 'high'.
// Lascia vuoto/non impostato per modelli come DeepSeek che non lo supportano.
const SCALEWAY_REASONING_EFFORT = process.env.SCALEWAY_REASONING_EFFORT || '';

// NUOVO: configurazione OpenAI per la lettura delle foto (foto -> testo)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';

// Mathpix: OCR specializzato in matematica/scienze (formule, frazioni,
// esponenti, notazione chimica). Legge anche testo normale (v3/text),
// quindi lo usiamo per TUTTE le foto, non solo quelle di matematica —
// se fallisce o non è configurato, si torna automaticamente a GPT-4o-mini.
const MATHPIX_APP_ID = process.env.MATHPIX_APP_ID || '';
const MATHPIX_APP_KEY = process.env.MATHPIX_APP_KEY || '';

// NUOVO: configurazione Revolut Business (pagamenti genitori)
// NUOVO: configurazione Google Play Billing (verifica acquisti/abbonamenti)
// GOOGLE_PACKAGE_NAME: il nome del pacchetto Android (es. net.iasmartproject.auramentor),
// lo trovi in android/app/build.gradle.kts alla voce applicationId.
// GOOGLE_SERVICE_ACCOUNT_JSON: il contenuto INTERO del file JSON della chiave di
// servizio Google Cloud, incollato come stringa su una riga sola nel .env.
const GOOGLE_PACKAGE_NAME = process.env.GOOGLE_PACKAGE_NAME || '';
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';

// ID prodotto → piano interno. Devono corrispondere ESATTAMENTE agli ID creati
// su Play Console in Monetizzazione → Prodotti in abbonamento.
const PIANO_PER_PRODOTTO_GOOGLE = {
    base_mensile: 'base',
    pro_mensile: 'pro',
};

let googlePlayClient = null;
function ottieniClienteGooglePlay() {
    if (googlePlayClient) return googlePlayClient;
    if (!GOOGLE_SERVICE_ACCOUNT_JSON) return null;
    try {
        const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/androidpublisher'],
        });
        googlePlayClient = google.androidpublisher({ version: 'v3', auth });
        return googlePlayClient;
    } catch (error) {
        console.error('❌ GOOGLE_SERVICE_ACCOUNT_JSON non valido:', error.message);
        return null;
    }

}

// Verifica un acquisto/abbonamento presso Google Play. Ritorna se è valido
// e, per gli abbonamenti, quando scade — così non ci si fida mai del solo
// client (chiunque potrebbe altrimenti "finger" di aver pagato).
async function verificaAcquistoGoogle(productId, purchaseToken) {
    const client = ottieniClienteGooglePlay();
    if (!client || !GOOGLE_PACKAGE_NAME) {
        return { ok: false, motivo: 'Verifica Google Play non configurata sul server.' };
    }
    try {
        // subscriptions.get (v1) è deprecato da Google: usiamo subscriptionsv2,
        // che ha una struttura diversa (subscriptionState invece di
        // paymentState, expiryTime come testo invece di expiryTimeMillis).
        const risposta = await client.purchases.subscriptionsv2.get({
            packageName: GOOGLE_PACKAGE_NAME,
            token: purchaseToken,
        });
        const dati = risposta.data;

        // Stati che consideriamo "abbonamento attivo": normale attivo, o in
        // periodo di tolleranza dopo un pagamento fallito (l'utente non deve
        // perdere l'accesso subito, vedi il periodo di tolleranza scelto su
        // Play Console).
        const statiValidi = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'];
        const valido = statiValidi.includes(dati.subscriptionState);

        const primoElemento = (dati.lineItems && dati.lineItems[0]) || {};
        const scadenza = primoElemento.expiryTime ? new Date(primoElemento.expiryTime) : null;

        return { ok: valido, scadenza };
    } catch (error) {
        console.error('❌ Errore verifica Google Play:', error.message);
        return { ok: false, motivo: 'Impossibile verificare l\'acquisto con Google.' };
    }
}
// Dove atterra il genitore dopo il pagamento (pagina web statica, non su questo server)
// (LANDING_PAGE_URL non più necessaria: i pagamenti passano da Google Play Billing)

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
const LIMITE_BASE_TESTO_SETTIMANALE = 105; // 15/giorno equivalente, ma usabile liberamente nella settimana
const LIMITE_PRO_TESTO_SETTIMANALE = 245; // 35/giorno equivalente
const LIMITE_PRO_FOTO_SETTIMANALE = 105; // 15/giorno equivalente; il Base non ha accesso alle foto
const LIMITE_ASSOLUTO_GIORNALIERO = 50; // tetto di sicurezza "fair usage" ANTI-ABUSO, resta per giorno singolo
const MAX_LEN_MESSAGGIO = 4000;
const MAX_LEN_NOME_PROF = 30;

// Ordine mostrato nell'app. "richiedeFoto" = va quasi sempre insieme a una foto
// (usato solo per UI/telemetria, il server non lo applica direttamente).
// "soloPro" = bloccata con lucchetto per prova-gratuita-esaurita e piano Base.
const MODALITA_INFO = {
    spiegami_concetto: { soloPro: false },
    aiuto_compiti: { soloPro: false },
    interrogami: { soloPro: false },
    ripasso: { soloPro: true },
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
const MEMORIA_NUMERO_MESSAGGI = 10;
// Quanti messaggi mostrare quando si riapre l'app (più ampio della memoria
// usata per il contesto dell'IA, che invece resta volutamente breve).
const STORICO_CHAT_LIMITE_MESSAGGI = 40;

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
    spiegami_concetto: 'Lo studente ti chiede di spiegare un concetto che non ha capito. Spiegalo in modo semplice e diretto, con un esempio concreto o un\'analogia della vita reale, evitando paroloni inutili. Copri 2-3 aspetti/punti collegati del concetto nella stessa risposta (non fermarti al primo dettaglio isolato): l\'obiettivo è dare una spiegazione che si tenga insieme e sia già utile da sola, non frammentarla in troppi scambi separati.',
    aiuto_compiti: 'Lo studente ha un esercizio da risolvere e vuole essere guidato, non la soluzione bella e pronta. Usa il metodo socratico: fai domande e dai indizi mirati, un passo alla volta, così arriva alla soluzione da solo.tranne che per la matematica e geografia',
    interrogami: 'Agisci come un professore che sta interrogando: fai una domanda alla volta sull\'argomento, aspetta la risposta, valutala brevemente, poi passa alla successiva. Dopo alcune domande, dai un voto orientativo (in decimi) e un consiglio su cosa ripassare. Se dai un voto, scrivilo sempre in questo formato esatto in una riga a parte: [VOTO_PREDITTIVO: X.X] seguito da una breve nota (es. "Pronto per la verifica di domani").',
    ripasso: 'Fai un ripasso completo e ben strutturato dell\'argomento portato dallo studente: copri TUTTI i concetti chiave principali dell\'argomento (non fermarti al primo, elencane almeno 4-6 se l\'argomento lo permette), ciascuno spiegato con 2-3 frasi chiare e un esempio pratico dove utile. Organizza il ripasso con elenchi puntati e grassetti sui termini importanti, così è facile da studiare e rileggere. Chiudi con 2-3 domande veloci per verificare che abbia capito. La priorità assoluta è la completezza e l\'utilità per studiare, non la simpatia.',
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

Stile: sii amichevole, diretto e un po' brillante — MAI noioso o ripetitivo, ma la sostanza viene sempre prima della simpatia: non sacrificare mai completezza o chiarezza per una battuta. Varia il modo in cui apri le risposte (non iniziare sempre allo stesso modo), usa un tono naturale come parlerebbe un tutor giovane e in gamba. Se proprio ci sta un tocco di leggerezza, va bene una frase o un'espressione informale, MAI a scapito del contenuto utile che lo studente deve effettivamente imparare. Rispondi sempre in italiano, con frasi chiare. Usa elenchi puntati e grassetti per i concetti chiave, senza esagerare con la formattazione.`;

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

        // DeepSeek V4 Flash usa il "pensiero" interno (thinking) per
        // ragionare prima di rispondere — utile davvero per problemi
        // complessi (matematica, geometria), dove aiuta a controllare il
        // ragionamento prima di scrivere la risposta finale. Il bug di
        // prima (risposta vuota su problemi molto confusi) non veniva dal
        // ragionamento in sé, ma da un margine di token troppo stretto:
        // ragionamento e risposta finale condividono lo stesso budget, e
        // 2500 non bastavano per entrambi sui casi più complicati. La
        // soluzione giusta è dare più margine (sotto), non disattivare il
        // ragionamento — che resta un vantaggio reale per la qualità delle
        // risposte, non un costo da tagliare.
        const corpoRichiesta = {
            model: SCALEWAY_MODEL,
            messages,
            max_tokens: 10000,
            temperature: 0.85,
        };
        // reasoning_effort: regola QUANTO ragiona (non se ragiona) — "low"
        // di default per restare veloce/economico su domande normali; si
        // può alzare da .env se serve più precisione su casi difficili.
        if (SCALEWAY_REASONING_EFFORT) {
            corpoRichiesta.reasoning_effort = SCALEWAY_REASONING_EFFORT;
        }

        const response = await fetch(`${SCALEWAY_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SCALEWAY_API_KEY}`,
            },
            body: JSON.stringify(corpoRichiesta),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Errore HTTP:', response.status, errorText);
            return { ok: false, testo: 'ERRORE: Impossibile elaborare la richiesta. Riprova più tardi.' };
        }

        const data = await response.json();

        if (!data.choices || !data.choices[0] || !data.choices[0].message || data.choices[0].message.content == null) {
            console.error('❌ Risposta Scaleway malformata:', JSON.stringify(data));
            // Caso specifico: il modello ha "ragionato" (reasoning) fino a
            // esaurire i token disponibili, senza mai arrivare a scrivere
            // una risposta vera — tipicamente su problemi descritti in modo
            // confuso/contraddittorio (es. una foto letta male). Diamo un
            // messaggio utile invece di un errore generico.
            const contenutoNullo = data.choices?.[0]?.message?.content == null;
            const haRagionatoTroppo = contenutoNullo && data.choices?.[0]?.finish_reason === 'length';
            return {
                ok: false,
                testo: haRagionatoTroppo
                    ? 'Il problema che hai scritto sembra un po\' confuso o incompleto (magari la foto è stata letta con qualche errore) — puoi provare a riscriverlo più chiaramente, magari passo per passo?'
                    : 'ERRORE: Risposta non valida dal servizio AI.',
            };
        }

        console.log('✅ Risposta ricevuta!');
        return { ok: true, testo: data.choices[0].message.content };

    } catch (error) {
        console.error('❌ Errore Scaleway:', error.message);
        return { ok: false, testo: 'ERRORE: Impossibile elaborare la richiesta. Riprova più tardi.' };
    }
}

// ============================================================
//  LETTURA FOTO: Mathpix (specializzato) con fallback su OpenAI Vision
// ============================================================

// Mathpix v3/text: legge sia testo normale sia notazione matematica/
// scientifica (formule, frazioni, esponenti, chimica) con precisione
// molto più alta di un modello generico su questo tipo di contenuto.
async function chiamataMathpixOCR(imageBase64, mimeType) {
    try {
        console.log('📤 Chiamata a Mathpix (foto->testo)...');
        const response = await fetch('https://api.mathpix.com/v3/text', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'app_id': MATHPIX_APP_ID,
                'app_key': MATHPIX_APP_KEY,
            },
            body: JSON.stringify({
                src: `data:${mimeType};base64,${imageBase64}`,
                formats: ['text'],
                ocr: ['math', 'text'],
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Errore HTTP Mathpix:', response.status, errorText);
            return { ok: false, testo: '' };
        }

        const data = await response.json();
        const testoLetto = (data.text || '').trim();

        if (testoLetto === '') {
            console.log('⚠️ Mathpix non ha trovato testo leggibile.');
            return { ok: false, testo: '' };
        }

        console.log('✅ Risposta ricevuta da Mathpix!');
        return { ok: true, testo: testoLetto };
    } catch (error) {
        console.error('❌ Errore Mathpix:', error.message);
        return { ok: false, testo: '' };
    }
}

// Funzione "smistatrice": prova prima Mathpix (più preciso, specie per
// matematica/scienze); se non è configurato o fallisce per qualsiasi
// motivo, ripiega automaticamente su GPT-4o-mini — così una foto non
// resta mai bloccata per un problema di un singolo fornitore.
async function leggiFotoConFallback(imageBase64, mimeType, modalita) {
    if (MATHPIX_APP_ID && MATHPIX_APP_KEY) {
        const risultatoMathpix = await chiamataMathpixOCR(imageBase64, mimeType);
        if (risultatoMathpix.ok) {
            return { ok: true, testo: risultatoMathpix.testo };
        }
        console.log('↩️ Mathpix non disponibile/fallito, ripiego su GPT-4o-mini...');
    }
    return chiamataOpenAIVisione(imageBase64, mimeType, modalita);
}

async function chiamataOpenAIVisione(imageBase64, mimeType, modalita) {
    try {
        console.log('📤 Chiamata a OpenAI (foto->testo)...');

        // Il prompt cambia leggermente a seconda del contesto: "Scanner dei
        // brutti voti" guarda una verifica GIÀ corretta dal prof (serve
        // leggere anche segni rossi, crocette, cerchiature, voto scritto a
        // mano) — mentre "Correggi compito" guarda un esercizio ancora da
        // correggere (serve solo il lavoro dello studente).
        const istruzioniSpecifiche = modalita === 'scanner_brutti_voti'
            ? 'Questa è una verifica GIÀ corretta da un insegnante. Oltre al testo stampato/scritto, presta particolare attenzione a: segni di correzione a penna (rossa o altro colore), crocette (X) su risposte sbagliate, cerchiature, segni di spunta, frasi o correzioni scritte a mano dall\'insegnante, e il voto finale se presente. Riporta chiaramente quali risposte sono segnate come sbagliate e quali correzioni ha scritto l\'insegnante, non solo il testo originale stampato.'
            : 'Trascrivi anche eventuali annotazioni a mano (crocette, cerchiature, correzioni), non solo il testo stampato.';

        // Istruzioni specifiche per la notazione matematica: senza queste,
        // il modello tende a "interpretare male" frazioni, esponenti,
        // radici o segni meno/moltiplicazione, producendo un testo che
        // sembra plausibile ma è sbagliato rispetto a quello vero scritto
        // sul foglio — un problema diverso (e più subdolo) del semplice
        // "non riesce a leggere".
        const istruzioniMatematica = 'Se nell\'immagine ci sono espressioni matematiche, equazioni o numeri con frazioni/esponenti/radici, trascrivile con MASSIMA precisione simbolo per simbolo, usando questa notazione testuale semplice: frazioni come "a/b" (es. 3/4), esponenti come "a^b" (es. x^2), radici come "sqrt(a)" o "radice di a", moltiplicazione come "*", divisione come ":" o "/". Non arrotondare, non semplificare e non "correggere" numeri che sembrano strani: riporta ESATTAMENTE le cifre e i simboli come appaiono nella foto, anche se il risultato sembra insolito — potrebbe essere proprio quello il punto dell\'esercizio. In caso di dubbio su una cifra poco leggibile, segnalalo esplicitamente (es. "il numero potrebbe essere 8 o 3, non è chiaro dalla foto") invece di indovinare in silenzio.';

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
                        content: `Trascrivi fedelmente TUTTO il contenuto visibile nell'immagine (es. esercizio, domanda, appunti): sia il testo stampato o scritto originariamente, sia qualsiasi annotazione aggiunta sopra. ${istruzioniSpecifiche} ${istruzioniMatematica} Se non c'è testo ma un problema visivo (es. un grafico, una figura geometrica), descrivi brevemente cosa serve per rispondere. Rispondi in italiano, solo con il contenuto utile, senza commenti aggiuntivi.`
                    },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Estrai il testo (incluse eventuali correzioni/annotazioni a mano ed espressioni matematiche esatte) o descrivi il problema in questa immagine:' },
                            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'high' } }
                        ]
                    }
                ],
                max_tokens: 1000,
                temperature: 0.1,
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
                    status: 'PROVA_ESAURITA',
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
                    status: 'PROVA_ESAURITA',
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

    // Limite SETTIMANALE (non più giornaliero) specifico per piano + tipo (testo o foto).
    // Lo studente può usarlo come vuole durante la settimana (es. tutto nel weekend),
    // invece di perdere le domande dei giorni in cui non ha usato l'app.
    let limiteSettimanale;
    if (tipo === 'foto') {
        limiteSettimanale = LIMITE_PRO_FOTO_SETTIMANALE; // il Base è già bloccato sopra
    } else {
        limiteSettimanale = pianoAttuale === 'pro' ? LIMITE_PRO_TESTO_SETTIMANALE : LIMITE_BASE_TESTO_SETTIMANALE;
    }

    const seteGiorniFa = new Date();
    seteGiorniFa.setDate(seteGiorniFa.getDate() - 7);

    const { count: contoTipoSettimana, error: countTipoError } = await supabase
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('device_id', deviceId)
        .eq('role', 'user')
        .eq('tipo', tipo)
        .gte('created_at', seteGiorniFa.toISOString());

    if (countTipoError) {
        console.error('❌ Errore conteggio settimanale per tipo:', countTipoError);
    } else if (contoTipoSettimana >= limiteSettimanale) {
        if (tipo === 'testo' && pianoAttuale === 'base') {
            return {
                ok: false,
                statusCode: 429,
                body: {
                    status: 'LIMITE_GIORNALIERO_UPSELL',
                    messaggio: 'Hai dato il massimo questa settimana! 🎉 Con il piano Pro hai la possibilità di continuare a studiare, più la possibilità di fotografare i tuoi esercizi. Vuoi dare un\'occhiata?',
                    messaggiRimanenti: 0,
                    limite: limiteSettimanale,
                }
            };
        }
        return {
            ok: false,
            statusCode: 429,
            body: {
                status: 'LIMITE_GIORNALIERO',
                messaggio: `Hai raggiunto il limite settimanale del piano ${pianoAttuale === 'pro' ? 'Pro' : 'Base'}. Il conteggio si aggiorna giorno per giorno, torna a trovarci presto!`,
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
// ============================================================
//  NUOVA API: REGISTRA CONSENSO (Privacy Policy + Termini)
//  Chiamata una sola volta, al primo completamento dell'onboarding.
//  Serve come prova della data di accettazione, in caso di controlli.
// ============================================================
app.post('/api/registra-consenso', async (req, res) => {
    const { deviceId } = req.body;

    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'deviceId mancante o non valido' });
    }

    try {
        const { error } = await supabase
            .from('users')
            .upsert({
                device_id: deviceId,
                consenso_termini_il: new Date().toISOString(),
            }, { onConflict: 'device_id', ignoreDuplicates: false });

        if (error) {
            console.error('❌ Errore registrazione consenso:', error);
            return res.status(500).json({ error: 'Errore interno' });
        }

        res.json({ status: 'OK' });
    } catch (error) {
        console.error('❌ Errore registra-consenso:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});

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

        // L'utente potrebbe non esistere ancora in questo momento (viene
        // creato di solito solo al primo vero messaggio in chat) — ma la
        // tabella fingerprints ha un vincolo di chiave esterna verso
        // users.device_id, quindi dobbiamo assicurarci che la riga utente
        // esista PRIMA di poter salvare il fingerprint.
        const { error: upsertUtenteError } = await supabase
            .from('users')
            .upsert({ device_id: deviceId }, { onConflict: 'device_id', ignoreDuplicates: true });

        if (upsertUtenteError) {
            console.error('❌ Errore creazione utente per fingerprint:', upsertUtenteError);
            return res.status(500).json({ error: 'Errore interno' });
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
// ============================================================
//  FUNZIONE CONDIVISA: COLLEGA UN GENITORE A UN DEVICE (per la dashboard)
//  Da qui in poi l'abbonamento si attiva SOLO tramite Google Play Billing
//  (endpoint /api/verifica-acquisto-google) — questa funzione serve solo
//  a dare al genitore accesso alla dashboard di monitoraggio, che è una
//  cosa distinta dal pagamento.
// ============================================================
async function collegaGenitoreADevice({ deviceId, emailGenitore, telefonoGenitore }) {
    const dashboardToken = generaTokenSicuro();

    const { error: insertGenitoreError } = await supabase
        .from('genitori')
        .insert({
            email_genitore: emailGenitore,
            telefono_genitore: telefonoGenitore || null,
            device_id_figlio: deviceId,
            dashboard_token: dashboardToken
        });

    if (insertGenitoreError) {
        return { ok: false, errore: insertGenitoreError };
    }

    // Il codice è "consumato": lo invalidiamo per impedirne il riuso
    const { error: updateUserError } = await supabase
        .from('users')
        .update({
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
    const { emailGenitore, telefonoGenitore, codiceInserito } = req.body;

    if (!emailGenitore || typeof emailGenitore !== 'string') {
        return res.status(400).json({ error: 'emailGenitore mancante o non valida' });
    }
    if (!codiceInserito || typeof codiceInserito !== 'string') {
        return res.status(400).json({ error: 'codiceInserito mancante o non valido' });
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

        const risultato = await collegaGenitoreADevice({
            deviceId: utente.device_id,
            emailGenitore,
            telefonoGenitore,
        });

        if (!risultato.ok) {
            console.error('❌ Errore collegamento genitore:', risultato.errore);
            return res.status(500).json({ error: 'Errore interno' });
        }

        res.json({
            success: true,
            messaggio: 'Collegamento riuscito! Ora hai accesso alla dashboard di monitoraggio.',
            dashboardToken: risultato.dashboardToken
        });

    } catch (error) {
        console.error('❌ Errore accoppiamento:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});


// ============================================================
//  NUOVA API: STATO SBLOCCO (l'app sul telefono dello studente fa
//  polling su questo endpoint mentre è ferma sulla schermata di blocco,
//  per sbloccarsi da sola non appena il genitore ha pagato)
// ============================================================
// ============================================================
//  NUOVA API: VERIFICA ACQUISTO GOOGLE PLAY
//  Chiamata dall'app subito dopo che lo studente/genitore completa un
//  abbonamento tramite Google Play Billing. Verifica presso Google che
//  l'acquisto sia reale prima di sbloccare qualsiasi funzione.
// ============================================================
app.post('/api/verifica-acquisto-google', async (req, res) => {
    const { deviceId, productId, purchaseToken } = req.body;

    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'deviceId mancante o non valido' });
    }
    if (!productId || !purchaseToken) {
        return res.status(400).json({ error: 'Dati di acquisto mancanti' });
    }

    const pianoValido = PIANO_PER_PRODOTTO_GOOGLE[productId];
    if (!pianoValido) {
        return res.status(400).json({ error: 'Prodotto non riconosciuto' });
    }

    try {
        const risultato = await verificaAcquistoGoogle(productId, purchaseToken);
        if (!risultato.ok) {
            return res.status(402).json({ error: risultato.motivo || 'Acquisto non valido' });
        }

        const scadenza = risultato.scadenza || (() => {
            const d = new Date();
            d.setMonth(d.getMonth() + 1);
            return d;
        })();

        const { error } = await supabase
            .from('users')
            .upsert({
                device_id: deviceId,
                tipo_abbonamento: pianoValido,
                scadenza_abbonamento: scadenza.toISOString(),
            }, { onConflict: 'device_id' });

        if (error) {
            console.error('❌ Errore salvataggio abbonamento Google:', error);
            return res.status(500).json({ error: 'Errore interno' });
        }

        console.log(`✅ Abbonamento ${pianoValido} attivato via Google Play per device ${deviceId}`);

        res.json({ status: 'OK', piano: pianoValido, scadenza: scadenza.toISOString() });
    } catch (error) {
        console.error('❌ Errore verifica-acquisto-google:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ============================================================
//  NUOVA API: STORICO CHAT (per ripopolare la conversazione quando si
//  riapre l'app, invece di ripartire sempre da una chat vuota)
// ============================================================
app.get('/api/storico-chat', async (req, res) => {
    const { deviceId, modalita } = req.query;

    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'deviceId mancante o non valido' });
    }

    try {
        let query = supabase
            .from('chat_messages')
            .select('id, role, content, tipo, created_at, preferito')
            .eq('device_id', deviceId)
            .in('role', ['user', 'assistant'])
            .order('created_at', { ascending: false })
            .limit(STORICO_CHAT_LIMITE_MESSAGGI);

        // Se una modalità è specificata, mostriamo solo la conversazione di
        // quella modalità (ha più senso: passando da "Interrogami" a
        // "Aiuto compiti" non ha senso rivedere le vecchie interrogazioni).
        if (modalita && typeof modalita === 'string') {
            query = query.eq('modalita', modalita);
        }

        const { data, error } = await query;

        if (error) {
            console.error('❌ Errore lettura storico chat:', error);
            return res.status(500).json({ error: 'Errore interno' });
        }

        // Le foto non vengono mai salvate (solo il segnaposto "[foto]"),
        // quindi le togliamo dallo storico mostrato: non c'è nulla di
        // significativo da ripopolare per quei messaggi.
        // Nota: id e preferito sono campi AGGIUNTIVI rispetto a prima —
        // un'app meno recente che ignora questi campi continua a
        // funzionare esattamente come prima (compatibilità mantenuta).
        const messaggi = (data || [])
            // Escludiamo solo il segnaposto vuoto "[foto]" (quello salvato
            // dall'endpoint di lettura foto, senza contenuto vero), NON i
            // messaggi con tipo='foto' che hanno il testo reale estratto
            // (quelli sì hanno un contenuto significativo da mostrare).
            .filter(m => m.content !== '[foto]')
            .reverse()
            .map(m => ({ id: m.id, role: m.role, content: m.content, preferito: m.preferito || false }));

        console.log(`📜 Storico chat richiesto: device=${deviceId}, modalita=${modalita || 'tutte'} → ${messaggi.length} messaggi trovati`);

        res.json({ messaggi });
    } catch (error) {
        console.error('❌ Errore storico-chat:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ============================================================
//  NUOVA API: SEGNA/TOGLI UN MESSAGGIO COME PREFERITO
// ============================================================
app.post('/api/messaggio-preferito', async (req, res) => {
    const { deviceId, messaggioId, preferito } = req.body;

    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'deviceId mancante o non valido' });
    }
    if (!messaggioId) {
        return res.status(400).json({ error: 'messaggioId mancante' });
    }

    try {
        const { error } = await supabase
            .from('chat_messages')
            .update({ preferito: preferito === true })
            .eq('id', messaggioId)
            .eq('device_id', deviceId); // sicurezza: solo il proprietario del messaggio

        if (error) {
            console.error('❌ Errore aggiornamento preferito:', error);
            return res.status(500).json({ error: 'Errore interno' });
        }

        res.json({ status: 'OK' });
    } catch (error) {
        console.error('❌ Errore messaggio-preferito:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ============================================================
//  NUOVA API: ELENCO DEI MESSAGGI PREFERITI (risposte salvate)
// ============================================================
app.get('/api/preferiti', async (req, res) => {
    const { deviceId } = req.query;

    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'deviceId mancante o non valido' });
    }

    try {
        const { data, error } = await supabase
            .from('chat_messages')
            .select('id, content, modalita, created_at')
            .eq('device_id', deviceId)
            .eq('preferito', true)
            .eq('role', 'assistant')
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) {
            console.error('❌ Errore lettura preferiti:', error);
            return res.status(500).json({ error: 'Errore interno' });
        }

        res.json({ preferiti: data || [] });
    } catch (error) {
        console.error('❌ Errore preferiti:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ============================================================
//  NUOVA API: CERCA NELLA CRONOLOGIA CHAT
// ============================================================
app.get('/api/cerca-chat', async (req, res) => {
    const { deviceId, query: testoRicerca } = req.query;

    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'deviceId mancante o non valido' });
    }
    if (!testoRicerca || typeof testoRicerca !== 'string' || testoRicerca.trim().length < 2) {
        return res.status(400).json({ error: 'Testo di ricerca troppo corto (minimo 2 caratteri)' });
    }

    try {
        const { data, error } = await supabase
            .from('chat_messages')
            .select('id, role, content, modalita, created_at')
            .eq('device_id', deviceId)
            .in('role', ['user', 'assistant'])
            .ilike('content', `%${testoRicerca.trim()}%`)
            .order('created_at', { ascending: false })
            .limit(30);

        if (error) {
            console.error('❌ Errore ricerca chat:', error);
            return res.status(500).json({ error: 'Errore interno' });
        }

        res.json({ risultati: data || [] });
    } catch (error) {
        console.error('❌ Errore cerca-chat:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ============================================================
//  NUOVA API: STATISTICHE PERSONALI DELLO STUDENTE
//  (diverse dalla dashboard genitori: qui è lo studente stesso a
//  vedere i propri progressi, come motivazione/gamification leggera)
// ============================================================
app.get('/api/statistiche-personali', async (req, res) => {
    const { deviceId } = req.query;

    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'deviceId mancante o non valido' });
    }

    try {
        const { data, error } = await supabase
            .from('chat_messages')
            .select('created_at')
            .eq('device_id', deviceId)
            .eq('role', 'user')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ Errore lettura statistiche:', error);
            return res.status(500).json({ error: 'Errore interno' });
        }

        const messaggi = data || [];
        const totaleMessaggi = messaggi.length;

        // Calcolo dei "giorni di fila" (streak): giorni consecutivi con
        // almeno un messaggio, contando all'indietro da oggi (o da ieri,
        // se oggi non ha ancora scritto nulla — non vogliamo azzerare lo
        // streak solo perché non ha ancora aperto l'app oggi).
        const giorniConAttivita = new Set(
            messaggi.map(m => new Date(m.created_at).toISOString().slice(0, 10))
        );

        let streak = 0;
        let cursore = new Date();
        // Se oggi non ha ancora scritto, si parte da ieri per il conteggio,
        // così lo streak non si azzera a mezzanotte prima che riapra l'app.
        const oggiStr = cursore.toISOString().slice(0, 10);
        if (!giorniConAttivita.has(oggiStr)) {
            cursore.setDate(cursore.getDate() - 1);
        }
        while (true) {
            const giornoStr = cursore.toISOString().slice(0, 10);
            if (giorniConAttivita.has(giornoStr)) {
                streak++;
                cursore.setDate(cursore.getDate() - 1);
            } else {
                break;
            }
        }

        res.json({
            totaleMessaggi,
            giorniAttivi: giorniConAttivita.size,
            streakGiorni: streak,
        });
    } catch (error) {
        console.error('❌ Errore statistiche-personali:', error);
        res.status(500).json({ error: 'Errore interno' });
    }
});



app.get('/api/stato-sblocco', async (req, res) => {
    const { deviceId } = req.query;

    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: 'deviceId mancante o non valido' });
    }

    const { data: utente, error } = await supabase
        .from('users')
        .select('tipo_abbonamento, scadenza_abbonamento, is_vip, messaggi_gratis_inviati')
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

    // Messaggi gratuiti rimanenti: rilevante solo per chi è ancora sul
    // piano free, così l'app sa subito (senza dover provare a mandare un
    // messaggio) se mostrare la chat normale o la schermata di abbonamento,
    // anche subito dopo aver riaperto l'app.
    const messaggiGratisRimanenti = utente.tipo_abbonamento === 'free'
        ? Math.max(0, LIMITE_MESSAGGI_GRATIS - (utente.messaggi_gratis_inviati || 0))
        : null;

    res.json({ sbloccato, tipoAbbonamento: utente.tipo_abbonamento, messaggiGratisRimanenti });
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
            .select('device_id_figlio, dashboard_token')
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

        const pianoAttuale = utente?.tipo_abbonamento || 'free';
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

        const risultato = await leggiFotoConFallback(imageBase64, tipoImmagine, modalita);

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
// Recupera la memoria della conversazione da dare all'IA come contesto.
// Prendiamo TRE gruppi, uniti senza doppioni:
//  1) tutti i messaggi con tipo='foto' in questa modalità — l'esercizio
//     estratto da una foto non deve MAI scivolare fuori dalla memoria,
//     anche se la chat va avanti a lungo dopo (è il caso segnalato che ha
//     fatto scoprire questo problema: "Aiuto compiti" con una foto perdeva
//     il filo del discorso dopo pochi scambi);
//  2) il primo scambio della conversazione (l'"ancora" del discorso, anche
//     quando non è una foto);
//  3) gli ultimi messaggi recenti, per il contesto immediato.
// Filtriamo sempre anche per modalità, per non mescolare conversazioni
// diverse (es. passando da "Interrogami" a "Aiuto compiti").
async function recuperaStorico(deviceId, modalita) {
    let queryFoto = supabase
        .from('chat_messages')
        .select('id, role, content')
        .eq('device_id', deviceId)
        .eq('tipo', 'foto')
        .in('role', ['user', 'assistant'])
        .order('created_at', { ascending: true });

    let queryPrimo = supabase
        .from('chat_messages')
        .select('id, role, content')
        .eq('device_id', deviceId)
        .in('role', ['user', 'assistant'])
        .order('created_at', { ascending: true })
        .limit(2);

    let queryRecenti = supabase
        .from('chat_messages')
        .select('id, role, content')
        .eq('device_id', deviceId)
        .in('role', ['user', 'assistant'])
        .order('created_at', { ascending: false })
        .limit(MEMORIA_NUMERO_MESSAGGI);

    if (modalita) {
        queryFoto = queryFoto.eq('modalita', modalita);
        queryPrimo = queryPrimo.eq('modalita', modalita);
        queryRecenti = queryRecenti.eq('modalita', modalita);
    }

    const [
        { data: foto, error: errFoto },
        { data: primi, error: errPrimi },
        { data: recenti, error: errRecenti },
    ] = await Promise.all([queryFoto, queryPrimo, queryRecenti]);

    if (errFoto || errPrimi || errRecenti) {
        console.error('❌ Errore lettura storico conversazione:', errFoto || errPrimi || errRecenti);
        return [];
    }

    const recentiOrdinati = (recenti || []).reverse();
    const idsGiaPresenti = new Set(recentiOrdinati.map(m => m.id));

    // Il primo scambio va aggiunto in cima solo se non già incluso tra i
    // recenti (conversazioni brevi, dove i due gruppi si sovrappongono).
    const primoAnchor = (primi || []).filter(m => !idsGiaPresenti.has(m.id));
    primoAnchor.forEach(m => idsGiaPresenti.add(m.id));

    // Le foto vanno aggiunte in ordine cronologico, prima di tutto il
    // resto, sempre evitando i doppioni.
    const fotoAnchor = (foto || []).filter(m => !idsGiaPresenti.has(m.id));

    return [...fotoAnchor, ...primoAnchor, ...recentiOrdinati].map(m => ({ role: m.role, content: m.content }));
}

// Estrae un eventuale voto predittivo scritto dall'AI nel formato
// [VOTO_PREDITTIVO: 7.5] e lo separa dal testo mostrato allo studente.
function estraiVotoPredittivo(testoRisposta) {
    if (typeof testoRisposta !== 'string') return { testoPulito: testoRisposta || '', voto: null };
    try {
        const match = testoRisposta.match(/\[VOTO_PREDITTIVO:\s*([\d.,]+)\]/i);
        if (!match || typeof match[1] !== 'string') return { testoPulito: testoRisposta, voto: null };
        const voto = parseFloat(match[1].replace(',', '.'));
        const testoPulito = testoRisposta.replace(match[0], '').trim();
        return { testoPulito, voto: isNaN(voto) ? null : voto };
    } catch (error) {
        // Rete di sicurezza: qualsiasi problema imprevisto qui non deve mai
        // far fallire l'intera risposta allo studente — nel dubbio,
        // mostriamo il testo così com'è, senza voto estratto.
        console.error('❌ Errore estrazione voto predittivo:', error.message);
        return { testoPulito: testoRisposta, voto: null };
    }
}

app.post('/api/chat', async (req, res) => {
    const { deviceId, messaggioStudente, nomeProf, modalita, fingerprintHash, daFoto } = req.body;

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
            { device_id: deviceId, role: 'user', content: messaggioStudente, tipo: daFoto ? 'foto' : 'testo', modalita: modalita || null },
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

            const storico = await recuperaStorico(deviceId, modalita);
            const risultatoIA = await chiamataScaleway(messaggioStudente, modalita, nomeProf, storico);
            const { testoPulito, voto } = estraiVotoPredittivo(risultatoIA.testo);

            const { data: righeVip, error: insertStoricoError } = await supabase
                .from('chat_messages')
                .insert([
                    { device_id: deviceId, role: 'user', content: messaggioStudente, tipo: daFoto ? 'foto' : 'testo', modalita: modalita || null },
                    { device_id: deviceId, role: 'assistant', content: testoPulito, tipo: daFoto ? 'foto' : 'testo', modalita: modalita || null, voto_predittivo: voto }
                ])
                .select('id, role');

            if (insertStoricoError) {
                console.error('⚠️ Errore salvataggio storico VIP:', insertStoricoError);
            }
            const messaggioIdVip = righeVip?.find(r => r.role === 'assistant')?.id ?? null;

            return res.json({
                status: 'OK',
                risposta: testoPulito,
                votoPredittivo: voto,
                messaggiRimanenti: 'VIP',
                daCache: false,
                messaggioId: messaggioIdVip
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

                const { data: righeCache, error: insertStoricoCacheError } = await supabase
                    .from('chat_messages')
                    .insert([
                        { device_id: deviceId, role: 'user', content: messaggioStudente, tipo: daFoto ? 'foto' : 'testo', modalita: modalita || null },
                        { device_id: deviceId, role: 'assistant', content: rispostaCache.risposta, tipo: 'testo', modalita: modalita || null }
                    ])
                    .select('id, role');

                if (insertStoricoCacheError) {
                    console.error('⚠️ Errore salvataggio storico cache:', insertStoricoCacheError);
                }
                const messaggioIdCache = righeCache?.find(r => r.role === 'assistant')?.id ?? null;

                return res.json({
                    status: 'OK',
                    risposta: rispostaCache.risposta,
                    messaggiRimanenti,
                    daCache: true,
                    messaggioId: messaggioIdCache
                });
            }
        }

        // ============================================================
        //  CHIAMA SCALEWAY (con memoria conversazione)
        // ============================================================
        const storico = await recuperaStorico(deviceId, modalita);
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
        const { data: righeStorico, error: insertStoricoError } = await supabase
            .from('chat_messages')
            .insert([
                { device_id: deviceId, role: 'user', content: messaggioStudente, tipo: daFoto ? 'foto' : 'testo', modalita: modalita || null },
                { device_id: deviceId, role: 'assistant', content: testoPulito, tipo: daFoto ? 'foto' : 'testo', modalita: modalita || null, voto_predittivo: voto }
            ])
            .select('id, role');

        if (insertStoricoError) {
            console.error('⚠️ Errore salvataggio storico:', insertStoricoError);
        }
        const messaggioId = righeStorico?.find(r => r.role === 'assistant')?.id ?? null;

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
            abbonamento: haAbbonamento ? utente.tipo_abbonamento : 'free',
            messaggioId
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
    console.log(`🧮 Mathpix (lettura matematica): ${MATHPIX_APP_ID && MATHPIX_APP_KEY ? '✅ Attivo' : '⚠️ Non configurato, uso solo GPT-4o-mini'}`);
    console.log(`🔐 Supabase key: ${process.env.SUPABASE_SERVICE_KEY ? 'service_role ✅' : 'anon/altra (verifica RLS!) ⚠️'}`);
    console.log(`🌍 CORS: ${ALLOWED_ORIGINS.includes('*') ? 'Aperto a tutti (solo sviluppo!)' : ALLOWED_ORIGINS.join(', ')}`);
    console.log(`📦 Cache: ${CACHE_SCADENZA_GIORNI} giorni`);
    console.log(`📊 Limiti settimanali testo: Base ${LIMITE_BASE_TESTO_SETTIMANALE}/settimana, Pro ${LIMITE_PRO_TESTO_SETTIMANALE}/settimana — Foto Pro: ${LIMITE_PRO_FOTO_SETTIMANALE}/settimana — Tetto anti-abuso: ${LIMITE_ASSOLUTO_GIORNALIERO}/giorno`);
    console.log(`👨‍👩‍👧 Codice accoppiamento: scade dopo ${CODICE_ACCOPPIAMENTO_SCADENZA_MINUTI} minuti`);
    console.log(`🌐 Trust proxy: attivo (necessario per rilevare l'IP reale dietro Scaleway)`);
});