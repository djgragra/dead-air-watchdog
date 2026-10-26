# Manual de Dead Air Watchdog

Dead Air Watchdog escucha día y noche la **tarjeta de sonido** del equipo y **cualquier número de streams Icecast / Shoutcast** a la vez (hasta 32 entradas) y envía un aviso por **correo, Telegram y/o HTTP** cuando el nivel se queda por debajo de un umbral durante más de N segundos. Vive en la bandeja del sistema, mantiene un registro de eventos local (exportable) y dibuja el gráfico de los silencios de los últimos 7, 14 o 30 días. Es una app de escritorio gratuita para Windows, macOS y Linux de OnAir Garage.

## Instalación y primer inicio

Descarga el instalador para tu sistema desde la página de [Releases](https://github.com/djgragra/dead-air-watchdog/releases) y compruébalo con `SHA256SUMS.txt`:
`Dead-Air-Watchdog-Setup-<V>.exe` (Windows), `Dead-Air-Watchdog-<V>-arm64.dmg` (Mac con Apple silicon), `Dead-Air-Watchdog-<V>-x64.dmg` (Mac con Intel), `Dead-Air-Watchdog-<V>.AppImage` (Linux).
La app es gratuita y no tiene certificado de Apple ni de Microsoft, así que en el primer inicio puede aparecer un aviso.

- **Windows**: ejecuta el instalador. Si SmartScreen dice «Windows protegió su PC», pulsa *Más información* → *Ejecutar de todos modos*.
- **macOS**: abre la imagen de disco y arrastra la app a Aplicaciones. La app tiene una firma ad-hoc, que es lo que necesita un Mac Apple silicon para abrirla. El primer inicio muestra igualmente el aviso «desarrollador no identificado»: abre *Ajustes del Sistema → Privacidad y seguridad*, desplázate hacia abajo y pulsa *Abrir de todos modos* (el clic derecho → Abrir ya no existe desde macOS 15). Si una versión anterior dice que la app está «dañada», ejecuta una vez en Terminal: `xattr -cr "/Applications/Dead Air Watchdog.app" && codesign --force --deep -s - "/Applications/Dead Air Watchdog.app"`
- **Linux**: haz ejecutable el AppImage (`chmod +x Dead-Air-Watchdog-*.AppImage`) y ejecútalo.

La app se abre siempre en inglés; elige Italiano o Español en los ajustes y la elección se recuerda. El tema es oscuro por defecto, con claro y de sistema disponibles.

**Por qué pide el micrófono.** Los sistemas operativos tratan cada entrada de audio (tarjeta de sonido, interfaz, mezclador USB) como un «micrófono», así que la petición de permiso es la misma. La app solo mide el nivel diez veces por segundo: **no** graba, guarda, reproduce ni envía el audio. La entrada se abre con el control automático de ganancia, la supresión de ruido y la cancelación de eco desactivados, de modo que el nivel medido es el real. Monitorizar la dirección de un stream no necesita ningún permiso.

## Cómo funciona

Cada 100 ms el motor de audio (una ventana oculta, así sigue funcionando cuando la ventana principal está cerrada) calcula el nivel de cada canal, en **dBFS**. El canal más fuerte se compara con el umbral; **silencio significa que todos los canales están por debajo**.

- Por debajo del umbral la entrada está *contando* (amarillo). Cuando dura al menos el tiempo configurado, pasa a *alarma* (rojo) y salen los avisos. El silencio se fecha desde su primer momento de calma.
- El audio ha *vuelto* solo después de quedarse igual o por encima del umbral durante 2 segundos seguidos, o 2 segundos en total dentro de 5 segundos: un solo clic en un tramo de silencio no reinicia la cuenta, y el habla con pausas entre las palabras cuenta como audio.
- Si la entrada no entrega nada (dispositivo retirado, stream caído, motor bloqueado), esto cuenta como dead air con causa **offline**.
- Si el programa no se ejecuta durante más de 10 segundos (el equipo se suspende o se cuelga), la cuenta se descarta y el periodo se escribe en el registro como hueco de monitorización.

El umbral por defecto es −50 dBFS y el tiempo por defecto 30 segundos. El nivel es un nivel simple, **no** una sonoridad: no es un instrumento certificado.

## Entradas

En *Ajustes → Entradas* añades hasta 32 entradas, en cualquier combinación:

- **Añadir la tarjeta de sonido**: elige el *Dispositivo* (tarjeta de sonido o interfaz) y los **canales a monitorizar**: Canales 1–2, 3–4, 5–6 o 7–8. Se pueden monitorizar juntas varias tarjetas, o varias parejas de la misma tarjeta (añade una entrada por pareja). Dos tarjetas con el mismo nombre se numeran, un dispositivo ya usado por otra entrada se marca en la lista, y un dispositivo guardado que ya no está se muestra como «no encontrado»: nunca se cambia por otra tarjeta.
- **Añadir un stream**: la dirección de un stream Icecast / Shoutcast (MP3, AAC, Ogg Vorbis u Opus, que empiece por `http://` o `https://`). El usuario y la contraseña escritos dentro de la dirección se enmascaran, con un botón de ojo para mostrarlos. Los streams HLS (`.m3u8`) no se admiten.
- Para cada entrada puedes fijar el **nombre** (se muestra en la tarjeta, en los avisos y en el registro), un **logo** (PNG, JPG, WebP, GIF o SVG de hasta 5 MB, guardado en este equipo), el **umbral de silencio**, el tiempo de **avisar tras**, y apagar **Monitorizar esta entrada**. Las flechas ▲ ▼ cambian el orden de las entradas, que es también el orden de las tarjetas.
- **Más opciones** de cada entrada: *Amarillo tras…* (2 segundos por defecto: el semáforo se queda en verde hasta que el audio ha estado por debajo del umbral ese tiempo), el **horario de monitorización** (días y horas, también pasada la medianoche, en que la entrada no se monitoriza o tiene su propio umbral y tiempo) y la **alarma de audio congelado** (apagada por defecto: el nivel se mantiene dentro de un pequeño margen, 1 dB por defecto, durante al menos 10 segundos aunque esté por encima del umbral: un tono fijo, un bucle atascado o ruido constante).

## Panel y modo pared

El **Panel** muestra un gran semáforo con el peor estado de todas las entradas (verde: todo OK; amarillo: hay una cuenta en curso; rojo: dead air; gris: parado) y una tarjeta por entrada con su estado, su cuenta y un medidor de nivel en directo con el umbral marcado.

En cada tarjeta, **Pausar los avisos de esta entrada** apaga los avisos de esa entrada durante 1 hora o hasta mañana a las 06:00 (por mantenimiento). La pausa termina sola, sobrevive a un reinicio y se escribe en el registro; la entrada se sigue midiendo y se muestra como EN PAUSA.

La **Vista compacta** (botón *Vista compacta* al final de la barra lateral, o en el menú de la bandeja) reduce la ventana para una pantalla llena de otros programas: sin barra lateral ni resumen, una fila por entrada con su nombre, su estado y dos barras finas de nivel, y una ventana mínima de unos 280 × 110 píxeles. *Vista normal* (en el mismo sitio y en la barra superior) devuelve la ventana a su tamaño y su lugar. **Siempre visible** mantiene la ventana por encima de las demás, en cualquiera de las dos vistas. Las dos opciones, y el lugar y el tamaño de cada vista, se recuerdan. En la vista compacta puedes **ocultar la barra de menús** (*Ajustes → General → Pantalla*, o el menú de la bandeja; Windows y Linux): clic derecho en la ventana para recuperarla, o Alt un momento. La página se amplía con Ctrl +, Ctrl − y Ctrl 0 o con Ctrl y la rueda del ratón; el zoom y el tamaño se recuerdan. En una ventana estrecha los botones quedan arriba y la insignia de estado pasa a la línea siguiente; en una muy estrecha las barras de nivel dejan sitio a los nombres. La detección y los avisos no cambian; el Modo pared sigue usando toda la pantalla como antes.

El **Modo pared** es para una pantalla siempre encendida en una redacción o un estudio: a pantalla completa, con la pantalla mantenida despierta, el reloj y la fecha tan grandes como la pantalla permita, una tarjeta grande por entrada (de 1 a 32; las tarjetas se reorganizan para caber) y un resplandor en el borde de la pantalla cuando algo va mal. En *Ajustes → General → Pantalla* eliges el resplandor (solo en modo pared, siempre, apagado), el tamaño de los nombres (automático, muy grande, grande, mediano, pequeño), los logotipos (pequeño junto al nombre, mediano, grande o un fondo suave) y si la app se abre directamente en modo pared.

## Avisos

En *Ajustes → Avisos* enciende los canales que quieras. Cada mensaje nombra la entrada y empieza por `[Dead Air Watchdog · nombre de la instalación]` (el nombre se fija en *Ajustes → General*).

- **Correo (SMTP)**: servidor, puerto, usuario, contraseña, remitente y destinatarios (varios en un solo campo, separados por comas). **Se envía un solo mensaje a todos con los destinatarios en copia oculta (Bcc).** Con un nombre de usuario la conexión debe estar cifrada (*Usar TLS desde el inicio*, normalmente puerto 465, o STARTTLS). *Enviar prueba* la comprueba.
- **Telegram**: el token del bot y uno o más destinatarios (ID de chat), cada uno con una nota. *Enviar prueba* comprueba que llega a todos.
- **HTTP (webhook)**: una petición a una dirección que elijas, POST con JSON o GET, con una cabecera Authorization opcional, para una pantalla de estudio o una automatización.
- **Notificación de escritorio** y una **alarma sonora** opcional en el equipo: un solo sonido para todas las entradas (pitidos de dos tonos con pausas), silenciado con un botón y rearmado por cada alarma nueva. El sonido sale por la salida predeterminada; con una entrada de micrófono cerca de los altavoces es más seguro una entrada de línea.
- **Repetir el aviso cada N minutos** mientras dure la alarma (0 = nunca).
- **Avisos de varias entradas a la vez**: cuando varias entradas caen, o vuelven, juntas, el primer aviso sale enseguida y los demás, dentro de la ventana de agrupación (60 segundos por defecto), siguen en un solo mensaje con la lista.
- **Texto de los avisos**: puedes escribir un texto propio para cada tipo de mensaje (dead air, audio congelado, recordatorio, audio recuperado, varias entradas caídas o recuperadas), con las palabras que enumera la ventana; *Volver al texto de la aplicación* restaura el predeterminado.

Todas las contraseñas, los tokens y las direcciones se guardan cifrados con el llavero del sistema (Keychain, DPAPI, libsecret) cuando está disponible. Solo se envían a tu propio servidor de correo, a Telegram y a la dirección HTTP que fijes.

## Registro de eventos y resumen

El **Registro de eventos** enumera, para cada entrada, el inicio, el fin, la duración, la causa (silencio, entrada offline, audio congelado) y la nota; también los periodos en que no se monitorizaba nada (app cerrada, equipo suspendido), las **pausas** y los **microsilencios**. Fíltralo por tipo o por entrada, y *Exportar CSV* o *Exportar JSON*. *Vaciar el registro…* borra todo tras confirmar. Un **gráfico** muestra el dead air por día en 7, 14 o 30 días, para todas las entradas o para una.

- **Microsilencios**: cada caída por debajo del umbral, por breve que sea, se registra con su hora, duración y causa, se cuenta por entrada y en total para hoy, y se conserva 30 días por defecto. No sale ningún aviso por ellos y la regla de la alarma no cambia: sirven para ajustar el umbral y para distinguir un fallo del programa de uno del stream o de la red. En canales de voz, o de música sin fundidos cruzados, pueden llenar el registro: desactívalos en *Ajustes → General → Escribir los microsilencios en el registro de eventos* para todas las entradas, o para una entrada en *Ajustes → Entradas → Más opciones → Microsilencios en el registro* (*Como en General*, *Escribirlos*, *No escribirlos*). Una entrada que los tiene desactivados no los escribe, no los cuenta ni los muestra, y el resumen no puede usarlos para distinguir un fallo del stream de uno de la red; los que ya están en el registro permanecen hasta que caducan. Por defecto están activados.
- **Resumen y problemas comunes**: para cada entrada la disponibilidad (la parte del tiempo monitorizado sin dead air; el tiempo en que la app no se ejecutaba, las pausas y las horas apagadas no cuentan), el número de alarmas, el dead air total y el más largo, para este mes, el mes pasado o los últimos 7 o 30 días, con exportación CSV. Cuando varias entradas pierden los datos o entran en alarma con menos de 10 segundos de diferencia, los eventos se marcan como **Problema común**: probablemente la red o el equipo, no los streams.

## Heartbeat

La app no puede avisarte de que el propio equipo está caído. El **Heartbeat** opcional (*Ajustes → Avisos*) envía una simple petición GET a una dirección que elijas cada 1 a 60 minutos durante la monitorización. Un servicio que avisa cuando estas peticiones se detienen (por ejemplo Healthchecks.io) te avisa cuando el equipo está apagado o suspendido, la app se ha cerrado por un error o la red está caída. La petición no lleva datos aparte de un User-Agent, y su dirección (normalmente un token secreto) se guarda cifrada. *Enviar ping de prueba* la comprueba.

## Ajustes

Los ajustes están en pestañas, en el mismo orden que en todas las apps de OnAir Garage. Pulsa *Guardar los ajustes* para conservar los cambios (*Descartar los cambios* vuelve atrás); un campo marcado en rojo hay que corregirlo antes.

| Pestaña | Contenido |
|---|---|
| General | Iniciar la app al iniciar sesión, iniciar oculta en la bandeja, iniciar la monitorización al abrir la app, evitar que el equipo se suspenda durante la monitorización, si se escriben los microsilencios en el registro y cuánto conservarlos, cuánto conservar el registro de eventos, el **nombre de esta instalación** (aparece en los avisos), idioma y tema, buscar actualizaciones, y las opciones de **Pantalla** del modo pared |
| Entradas | Las entradas, con su dispositivo o dirección, nombre, logo, umbral, tiempo y opciones |
| Avisos | Correo, Telegram, HTTP, el sonido, la repetición, la agrupación, el texto de los avisos y el heartbeat |
| Actualizaciones | La actualización guiada (véase más abajo) |
| Copia | Exportación e importación de la configuración |

**Copia de seguridad**: *Exportar* guarda las entradas, los umbrales, los avisos, el heartbeat y los ajustes generales como `dead-air-watchdog-backup-AAAA-MM-DD.json`. Las contraseñas y los tokens (la contraseña del correo, el token de Telegram, la dirección del heartbeat, el usuario y la contraseña dentro de la dirección de un stream, la dirección y la cabecera HTTP) **se dejan fuera** salvo que marques *Incluir contraseñas y tokens* (un aviso rojo dice que el archivo los contendrá en texto sin formato). *Importar* puede sustituir todo o añadir solo las entradas que este equipo no tiene, y la app enumera lo que hay que volver a escribir. Un valor guardado cifrado no se puede leer en otro equipo o cuenta, así que una copia no lo lleva nunca.

**Ayuda e info** tiene la versión, la licencia y los créditos, *Copiar info para soporte* (versión, sistema, última comprobación y último error: nunca ajustes, direcciones ni contraseñas), *Abrir la carpeta de registros* (un registro al día, 7 días, 5 MB cada uno) y la tarjeta de propina: la hucha y el botón abren ambos la página de apoyo del sitio web en el idioma de la app; dentro de la app no se pide nunca nada. La ventana recuerda su posición y tamaño.

## Actualizaciones

La app busca una versión nueva 15 segundos después de iniciarse y luego cada 24 horas (se puede desactivar en *Ajustes → Actualizaciones*). Un aviso ofrece *Descargar e instalar*, *Recordármelo más tarde* (24 horas) y *Omitir esta versión*, con las notas de la versión. La descarga muestra una barra de progreso, se puede cancelar y se comprueba con el SHA-256 de la versión (`SHA256SUMS.txt`). *Cerrar e instalar* pregunta antes (la monitorización se detiene), guarda una copia de seguridad de los ajustes y después inicia el instalador (Windows), abre la imagen de disco (macOS) o muestra el AppImage (Linux). Tras la actualización aparece una vez la ventana *Novedades*. No se descarga ni se instala nada sin un clic.

Como los equipos que ejecutan esta app suelen quedarse solos, una versión nueva se anuncia también **una vez por versión** por correo y Telegram, cuando están configurados (se puede desactivar): un equipo que se ha quedado en una versión anterior no puede anunciar nada hasta que se actualice a mano.

## Límites

- No es un instrumento certificado. El nivel es un nivel simple, no una sonoridad.
- Un stream se escucha como cualquier oyente: aparece en las estadísticas de oyentes del servidor, llega con el retraso del búfer del stream, y si el servidor reproduce un relleno cuando cae la fuente, el monitor oye ese audio, no el silencio.
- Mientras el equipo está suspendido o apagado, o la app está cerrada, no se monitoriza nada y no puede salir ningún aviso: para eso está el heartbeat.
- Cada stream es un decodificador más y cada tarjeta de sonido una captura más en el sistema; el límite son las 32 entradas de la app. Una tarjeta en uso exclusivo por otro programa en Windows no se puede abrir (la entrada lo dice).

## Solución de problemas

| Problema | Qué hacer |
|---|---|
| macOS: «la app está dañada / no se puede abrir» | Abre *Ajustes del Sistema → Privacidad y seguridad → Abrir de todos modos*; para una versión anterior, ejecuta en Terminal `xattr -cr "/Applications/Dead Air Watchdog.app" && codesign --force --deep -s - "/Applications/Dead Air Watchdog.app"`. |
| Windows: «Windows protegió su PC» | *Más información* → *Ejecutar de todos modos*. |
| Linux: el AppImage no se inicia | Hazlo ejecutable (`chmod +x`) e instala FUSE (`libfuse2`) si tu sistema lo necesita. |
| La tarjeta de sonido dice «no encontrado» | El dispositivo guardado ya no está: vuelve a conectarlo, pulsa *Actualizar la lista* y elígelo de nuevo. |
| Una entrada muestra «offline» | Falta el dispositivo o el stream está caído; la app se reconecta sola. |
| No llega ningún aviso | Usa *Enviar prueba* en *Ajustes → Avisos* y lee el mensaje de error. |
| Falsas alarmas durante el habla | Baja el umbral o sube *Avisar tras*; las pausas entre palabras no cuentan como silencio una vez que el audio ha vuelto durante 2 segundos. |
| La descarga de la actualización falló con «checksum mismatch» | El archivo se eliminó automáticamente. Inténtalo de nuevo o descarga el instalador a mano desde la página de versiones. |

## Contactos

Graziano Melzi · OnAir Garage — `https://onairgarage.com` — `hello@onairgarage.com`. Página de la herramienta: `https://onairgarage.com/tools/dead-air-watchdog/`. Código fuente y versiones: `https://github.com/djgragra/dead-air-watchdog`. Licencia: MIT © 2026 Graziano Melzi.
