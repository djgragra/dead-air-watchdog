# Manuale di Dead Air Watchdog

Dead Air Watchdog ascolta giorno e notte la **scheda audio** del computer e **un numero qualsiasi di stream Icecast / Shoutcast** nello stesso momento (fino a 32 ingressi) e manda un avviso via **email, Telegram e/o HTTP** quando il livello resta sotto una soglia per più di N secondi. Vive nella tray di sistema, tiene un registro eventi locale (esportabile) e disegna il grafico dei silenzi degli ultimi 7, 14 o 30 giorni. È un'app desktop gratuita per Windows, macOS e Linux di OnAir Garage.

## Installazione e primo avvio

Scarica l'installer per il tuo sistema dalla pagina [Releases](https://github.com/djgragra/dead-air-watchdog/releases) e controllalo con `SHA256SUMS.txt`:
`Dead-Air-Watchdog-Setup-<V>.exe` (Windows), `Dead-Air-Watchdog-<V>-arm64.dmg` (Mac con Apple silicon), `Dead-Air-Watchdog-<V>-x64.dmg` (Mac con Intel), `Dead-Air-Watchdog-<V>.AppImage` (Linux).
L'app è gratuita e non ha un certificato Apple o Microsoft, quindi al primo avvio può comparire un avviso.

- **Windows**: avvia l'installer. Se SmartScreen dice «Windows ha protetto il PC», clicca *Ulteriori informazioni* → *Esegui comunque*.
- **macOS**: apri l'immagine disco e trascina l'app in Applicazioni. L'app è firmata ad-hoc, ed è ciò che serve a un Mac Apple silicon per aprirla. Il primo avvio mostra comunque l'avviso «sviluppatore non identificato»: apri *Impostazioni di Sistema → Privacy e sicurezza*, scorri in basso e clicca *Apri comunque* (il clic destro → Apri non esiste più da macOS 15). Se una versione precedente dice che l'app è «danneggiata», esegui una volta nel Terminale: `xattr -cr "/Applications/Dead Air Watchdog.app" && codesign --force --deep -s - "/Applications/Dead Air Watchdog.app"`
- **Linux**: rendi eseguibile l'AppImage (`chmod +x Dead-Air-Watchdog-*.AppImage`) e avviala.

L'app si apre sempre in inglese; scegli Italiano o Español nelle impostazioni e la scelta viene ricordata. Il tema è scuro per default, con chiaro e di sistema disponibili.

**Perché chiede il microfono.** I sistemi operativi trattano ogni ingresso audio (scheda audio, interfaccia, mixer USB) come un «microfono», quindi la richiesta di permesso è la stessa. L'app misura solo il livello dieci volte al secondo: **non** registra, salva, riproduce né invia l'audio. L'ingresso viene aperto con controllo automatico del guadagno, soppressione del rumore e cancellazione dell'eco disattivati, così il livello misurato è quello reale. Monitorare l'indirizzo di uno stream non richiede nessun permesso.

## Come funziona

Ogni 100 ms il motore audio (una finestra nascosta, così continua a funzionare quando la finestra principale è chiusa) calcola il livello di ogni canale, in **dBFS**. Il canale più forte viene confrontato con la soglia; **silenzio significa che tutti i canali sono sotto**.

- Sotto la soglia l'ingresso è *in conteggio* (giallo). Quando dura almeno il tempo configurato, diventa un *allarme* (rosso) e partono gli avvisi. Il silenzio è datato dal suo primo momento di quiete.
- L'audio è *tornato* solo dopo che resta uguale o sopra la soglia per 2 secondi di fila, oppure 2 secondi in totale entro 5 secondi: un solo clic in un tratto di silenzio non fa ripartire il conteggio, e il parlato con pause tra le parole conta come audio.
- Se l'ingresso non consegna nulla (dispositivo rimosso, stream caduto, motore bloccato) questo conta come dead air con causa **offline**.
- Se il programma non gira per più di 10 secondi (il computer va in sospensione o si blocca), il conteggio viene scartato e il periodo è scritto nel registro come buco di monitoraggio.

La soglia predefinita è −50 dBFS e il tempo predefinito 30 secondi. Il livello è un livello semplice, **non** una loudness: non è uno strumento certificato.

## Ingressi

In *Impostazioni → Ingressi* aggiungi fino a 32 ingressi, in qualsiasi combinazione:

- **Aggiungi la scheda audio**: scegli il *Dispositivo* (scheda audio o interfaccia) e i **canali da monitorare**: Canali 1–2, 3–4, 5–6 o 7–8. Più schede, o più coppie della stessa scheda, si possono monitorare insieme (aggiungi un ingresso per coppia). Due schede con lo stesso nome vengono numerate, un dispositivo già usato da un altro ingresso è segnato nell'elenco, e un dispositivo salvato che non c'è più viene mostrato come «non trovato»: non viene mai sostituito con un'altra scheda.
- **Aggiungi uno stream**: l'indirizzo di uno stream Icecast / Shoutcast (MP3, AAC, Ogg Vorbis o Opus, che inizia con `http://` o `https://`). Utente e password scritti dentro l'indirizzo vengono mascherati, con un pulsante a occhio per mostrarli. Gli stream HLS (`.m3u8`) non sono supportati.
- Per ogni ingresso puoi impostare il **nome** (mostrato sulla tessera, negli avvisi e nel registro), un **logo** (PNG, JPG, WebP, GIF o SVG fino a 5 MB, conservato su questo computer), la **soglia di silenzio**, il tempo di **avviso dopo**, e spegnere **Monitora questo ingresso**. Le frecce ▲ ▼ cambiano l'ordine degli ingressi, che è anche l'ordine delle tessere.
- **Altre opzioni** di ogni ingresso: *Giallo dopo…* (2 secondi per default: il semaforo resta verde finché l'audio non è stato sotto soglia per quel tempo), gli **orari di monitoraggio** (giorni e ore, anche oltre la mezzanotte, in cui l'ingresso non viene monitorato o ha una propria soglia e un proprio tempo) e l'**allarme per audio bloccato** (spento per default: il livello resta entro un piccolo intervallo, 1 dB per default, per almeno 10 secondi pur essendo sopra la soglia: un tono fisso, un loop bloccato o rumore costante).

## Dashboard e Wall display

La **Dashboard** mostra un grande semaforo con lo stato peggiore di tutti gli ingressi (verde: tutto OK; giallo: un conteggio è in corso; rosso: dead air; grigio: fermo) e una tessera per ingresso con il suo stato, il suo conteggio e un misuratore di livello dal vivo con la soglia segnata.

Su ogni tessera, **Metti in pausa gli avvisi di questo ingresso** spegne gli avvisi di quell'ingresso per 1 ora o fino a domani alle 06:00 (per manutenzione). La pausa finisce da sola, sopravvive a un riavvio ed è scritta nel registro; l'ingresso viene comunque misurato e mostrato come IN PAUSA.

La **Vista compatta** (pulsante *Vista compatta* in fondo alla barra laterale, o nel menu della tray) riduce la finestra per uno schermo pieno di altri programmi: niente barra laterale né riepilogo, una riga per ingresso con nome, stato e due barre sottili di livello, e una finestra minima di circa 280 × 110 pixel. *Vista normale* (nello stesso punto e nella barra in alto) riporta la finestra alle sue dimensioni e al suo posto. **Sempre in primo piano** tiene la finestra sopra le altre, in entrambe le viste. Le due scelte, e posizione e dimensione di ciascuna vista, vengono ricordate. Il rilevamento e gli avvisi non cambiano; il Wall display usa sempre tutto lo schermo come prima.

Il **Wall display** è per uno schermo sempre acceso in una redazione o in uno studio: a schermo intero, con lo schermo tenuto sveglio, l'orologio e la data grandi quanto lo schermo permette, una tessera grande per ingresso (da 1 a 32; le tessere si riordinano per starci) e un alone sul bordo dello schermo quando qualcosa non va. In *Impostazioni → Generali → Schermo* scegli l'alone (solo nel Wall display, sempre, spento), la dimensione dei nomi (automatica, grande, media, piccola), i loghi (piccolo accanto al nome, grande, o uno sfondo tenue) e se l'app si apre direttamente nel Wall display.

## Avvisi

In *Impostazioni → Avvisi* accendi i canali che vuoi. Ogni messaggio nomina l'ingresso e inizia con `[Dead Air Watchdog · nome dell'installazione]` (il nome si imposta in *Impostazioni → Generali*).

- **Email (SMTP)**: server, porta, utente, password, mittente e destinatari (più indirizzi in un solo campo, separati da virgole). **Un solo messaggio va a tutti con i destinatari in Bcc.** Con un nome utente la connessione deve essere cifrata (*Usa TLS fin dall'inizio*, di solito porta 465, oppure STARTTLS). *Invia prova* la controlla.
- **Telegram**: il token del bot e uno o più destinatari (chat ID), ciascuno con una nota. *Invia prova* controlla che arrivi a tutti.
- **HTTP (webhook)**: una richiesta a un indirizzo che scegli, POST con JSON o GET, con un'intestazione Authorization facoltativa, per uno schermo di studio o un'automazione.
- **Notifica sul desktop** e un **suono d'allarme** facoltativo sul computer: un solo suono per tutti gli ingressi (bip a due toni con pause), silenziato con un pulsante e riarmato da ogni nuovo allarme. Il suono esce dall'uscita predefinita; con un ingresso microfonico vicino agli altoparlanti è più sicuro un ingresso di linea.
- **Ripeti l'avviso ogni N minuti** finché dura l'allarme (0 = mai).
- **Avvisi per più ingressi insieme**: quando più ingressi cadono, o tornano, insieme, il primo avviso parte subito e gli altri entro la finestra di raggruppamento (60 secondi per default) seguono in un unico messaggio con l'elenco.
- **Testo degli avvisi**: puoi scrivere un testo tuo per ogni tipo di messaggio (dead air, audio bloccato, promemoria, audio tornato, più ingressi caduti o tornati), con le parole che la finestra elenca; *Torna al testo dell'app* ripristina quello predefinito.

Tutte le password, i token e gli indirizzi sono conservati cifrati con il portachiavi del sistema (Keychain, DPAPI, libsecret) quando è disponibile. Vengono inviati solo al tuo server di posta, a Telegram e all'indirizzo HTTP che imposti.

## Registro eventi e riepilogo

Il **Registro eventi** elenca, per ogni ingresso, l'inizio, la fine, la durata, la causa (silenzio, ingresso offline, audio bloccato) e la nota; anche i periodi in cui non si monitorava nulla (app chiusa, computer in sospensione), le **pause** e i **micro-silenzi**. Filtralo per tipo o per ingresso, e *Esporta CSV* o *Esporta JSON*. *Svuota il registro…* cancella tutto dopo conferma. Un **grafico** mostra il dead air per giorno su 7, 14 o 30 giorni, per tutti gli ingressi o per uno.

- **Micro-silenzi**: ogni calo sotto la soglia, per quanto breve, viene registrato con ora, durata e causa, contato per ingresso e in totale per oggi, e conservato per 30 giorni per default. Per loro non parte nessun avviso e la regola dell'allarme non cambia: servono a regolare la soglia e a distinguere un guasto del programma da uno dello stream o della rete. Con canali di parlato, o musica senza dissolvenze incrociate, possono riempire il registro: spegnili in *Impostazioni → Generali → Scrivi i micro-silenzi nel registro eventi* per tutti gli ingressi, oppure per un ingresso in *Impostazioni → Ingressi → Altre opzioni → Micro-silenzi nel registro* (*Come in Generale*, *Scrivili*, *Non scriverli*). Un ingresso che li ha spenti non li scrive, non li conta e non li mostra, e il riepilogo non può usarli per distinguere un guasto dello stream da uno della rete; quelli già nel registro restano fino alla scadenza. Di default sono attivi.
- **Riepilogo e problemi comuni**: per ogni ingresso la disponibilità (la quota di tempo monitorato senza dead air; il tempo in cui l'app non girava, le pause e le ore spente non contano), il numero di allarmi, il dead air totale e il più lungo, per questo mese, il mese scorso o gli ultimi 7 o 30 giorni, con esportazione CSV. Quando più ingressi perdono i dati o vanno in allarme a meno di 10 secondi l'uno dall'altro, gli eventi sono segnati come **Problema comune**: probabilmente la rete o il computer, non gli stream.

## Heartbeat

L'app non può avvisarti che il computer stesso è spento. Il **Heartbeat** facoltativo (*Impostazioni → Avvisi*) manda una semplice richiesta GET a un indirizzo che scegli ogni 1–60 minuti durante il monitoraggio. Un servizio che avvisa quando queste richieste si fermano (per esempio Healthchecks.io) ti avverte quando il computer è spento o in sospensione, l'app è andata in crash o la rete è caduta. La richiesta non porta dati oltre a uno User-Agent, e il suo indirizzo (di solito un token segreto) è conservato cifrato. *Invia un ping di prova* lo controlla.

## Impostazioni

Le impostazioni sono in schede, nello stesso ordine di ogni app OnAir Garage. Premi *Salva le impostazioni* per tenere le modifiche (*Annulla le modifiche* torna indietro); un campo segnato in rosso va corretto prima.

| Scheda | Contenuto |
|---|---|
| Generali | Avvia l'app all'accesso, avvia nascosta nella tray, avvia il monitoraggio all'apertura dell'app, impedisci la sospensione del computer durante il monitoraggio, se scrivere i micro-silenzi nel registro e per quanto conservarli, per quanto conservare il registro eventi, il **nome di questa installazione** (compare negli avvisi), lingua e tema, controlla gli aggiornamenti, e le opzioni **Schermo** del Wall display |
| Ingressi | Gli ingressi, con dispositivo o indirizzo, nome, logo, soglia, tempo e opzioni |
| Avvisi | Email, Telegram, HTTP, il suono, la ripetizione, il raggruppamento, il testo degli avvisi e l'heartbeat |
| Aggiornamenti | L'aggiornamento guidato (vedi sotto) |
| Backup | Esportazione e importazione della configurazione |

**Backup**: *Esporta* salva ingressi, soglie, avvisi, heartbeat e impostazioni generali come `dead-air-watchdog-backup-AAAA-MM-GG.json`. Password e token (la password email, il token Telegram, l'indirizzo dell'heartbeat, utente e password dentro l'indirizzo di uno stream, l'indirizzo e l'intestazione HTTP) **restano fuori** a meno che spunti *Includi password e token* (un avviso rosso dice che il file li conterrà in chiaro). *Importa* può sostituire tutto o aggiungere solo gli ingressi che questo computer non ha, e l'app elenca cosa va riscritto. Un valore conservato cifrato non si può leggere su un altro computer o account, quindi un backup non lo porta mai.

**Guida e info** ha la versione, la licenza e i crediti, *Copia info per assistenza* (versione, sistema, ultimo controllo e ultimo errore: mai impostazioni, indirizzi o password), *Apri cartella dei log* (un log al giorno, 7 giorni, 5 MB ciascuno) e il riquadro mancia: il salvadanaio e il pulsante aprono entrambi la pagina di sostegno del sito nella lingua dell'app; dentro l'app non viene mai chiesto nulla. La finestra ricorda posizione e dimensione.

## Aggiornamenti

L'app cerca una nuova versione 15 secondi dopo l'avvio e poi ogni 24 ore (disattivabile in *Impostazioni → Aggiornamenti*). Un avviso offre *Scarica e installa*, *Ricordamelo dopo* (24 ore) e *Salta questa versione*, con le note di rilascio. Il download mostra una barra di avanzamento, si può annullare e viene controllato con lo SHA-256 della release (`SHA256SUMS.txt`). *Chiudi e installa* chiede prima conferma (il monitoraggio si ferma), salva una copia di sicurezza delle impostazioni, poi avvia l'installer (Windows), apre l'immagine disco (macOS) o mostra l'AppImage (Linux). Dopo l'aggiornamento compare una volta la finestra *Novità*. Niente viene scaricato né installato senza un clic.

Poiché i computer che fanno girare quest'app sono spesso lasciati da soli, una nuova versione viene annunciata anche **una volta per versione** via email e Telegram, quando sono configurati (disattivabile): un computer rimasto a una versione precedente non può annunciare nulla finché non viene aggiornato a mano.

## Limiti

- Non è uno strumento certificato. Il livello è un livello semplice, non una loudness.
- Uno stream si ascolta come qualsiasi ascoltatore: compare nelle statistiche degli ascoltatori del server, arriva in ritardo del buffer dello stream, e se il server riproduce un riempitivo quando la sorgente cade, il monitor sente quell'audio, non il silenzio.
- Mentre il computer è in sospensione o spento, o l'app è chiusa, non si monitora nulla e nessun avviso può partire: per questo c'è l'heartbeat.
- Ogni stream è un decodificatore in più e ogni scheda audio una cattura in più nel sistema; il limite sono i 32 ingressi dell'app. Una scheda in uso esclusivo da un altro programma su Windows non si può aprire (l'ingresso lo dice).

## Risoluzione dei problemi

| Problema | Cosa fare |
|---|---|
| macOS: «l'app è danneggiata / non può essere aperta» | Apri *Impostazioni di Sistema → Privacy e sicurezza → Apri comunque*; per una versione precedente, esegui nel Terminale `xattr -cr "/Applications/Dead Air Watchdog.app" && codesign --force --deep -s - "/Applications/Dead Air Watchdog.app"`. |
| Windows: «Windows ha protetto il PC» | *Ulteriori informazioni* → *Esegui comunque*. |
| Linux: l'AppImage non si avvia | Rendila eseguibile (`chmod +x`) e installa FUSE (`libfuse2`) se il tuo sistema lo richiede. |
| La scheda audio dice «non trovato» | Il dispositivo salvato non c'è più: ricollegalo, premi *Aggiorna l'elenco* e sceglilo di nuovo. |
| Un ingresso mostra «offline» | Il dispositivo manca o lo stream è caduto; l'app si riconnette da sola. |
| Non arriva nessun avviso | Usa *Invia prova* in *Impostazioni → Avvisi* e leggi il messaggio d'errore. |
| Falsi allarmi durante il parlato | Abbassa la soglia o alza *Avvisa dopo*; le pause tra le parole non contano come silenzio una volta che l'audio è tornato per 2 secondi. |
| Il download dell'aggiornamento è fallito con «checksum mismatch» | Il file è stato eliminato automaticamente. Riprova, oppure scarica l'installer a mano dalla pagina delle release. |

## Contatti

Graziano Melzi · OnAir Garage — `https://onairgarage.com` — `hello@onairgarage.com`. Pagina dello strumento: `https://onairgarage.com/tools/dead-air-watchdog/`. Codice sorgente e release: `https://github.com/djgragra/dead-air-watchdog`. Licenza: MIT © 2026 Graziano Melzi.
