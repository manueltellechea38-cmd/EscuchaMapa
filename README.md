# EscuchaMapa v2

PWA hecha con HTML, CSS y JavaScript para grabar clases o conversaciones, transcribirlas y separar el tema principal del ruido o las partes secundarias.

## Cambios principales de v2

- Español (Uruguay).
- Inglés.
- Modo bilingüe Español + English.
- Dos transcripciones:
  - Texto completo: conserva todo.
  - Texto limpio: intenta dejar solamente la conversación central.
- Detección automática del tema.
- Posibilidad de escribir y fijar manualmente el tema.
- Tres niveles de filtrado: suave, normal y estricto.
- Limpieza de muletillas comunes.
- Supresión de eco, ruido y control automático de ganancia cuando el navegador lo soporta.
- Filtro de audio pasa-altos + compresor para una grabación más clara.
- Grabación en fragmentos de 1 segundo.
- Persistencia temporal de fragmentos de audio en IndexedDB durante la sesión.
- Wake Lock cuando está disponible.
- Media Session para indicar que hay una sesión activa.
- Audio silencioso de mantenimiento en "modo resistente".
- Registro de cambios primer plano/segundo plano.
- Mapa conceptual y resumen basados solamente en el texto central.
- Preguntas para estudiar.
- Palabras clave.
- Notas.
- Historial local.
- Exportación TXT y JSON.

## Cómo ejecutar

1. Descomprimí el ZIP.
2. Abrí la carpeta `EscuchaMapa` con VS Code.
3. Ejecutá `iniciar-servidor.bat`.
4. Abrí `http://localhost:5500`.
5. Permití el micrófono.

No conviene abrir `index.html` directamente porque el micrófono, el Service Worker y varias APIs necesitan localhost o HTTPS.

## Instalar como aplicación

### PC / Chrome / Edge
Usá el botón "Instalar app" si aparece, o la opción de instalación del navegador.

### iPhone
Para usarla como PWA en iPhone debe estar publicada bajo HTTPS:
1. Abrí la URL en Safari.
2. Compartir.
3. Agregar a pantalla de inicio.

## Cómo funciona el filtro del tema

La aplicación no borra información del registro completo.

Cada fragmento reconocido:
1. se agrega al texto completo;
2. se limpia de algunas muletillas;
3. se compara con las palabras del tema;
4. se compara con fragmentos centrales recientes;
5. se compara con las palabras más repetidas de la conversación;
6. según el nivel de filtro, se acepta o se deja solamente en el registro completo.

Durante los primeros fragmentos el filtro es más permisivo porque todavía está aprendiendo cuál es el tema.

Si sabés de qué se va a hablar, escribí el tema antes de grabar y tocá "Fijar tema". Eso mejora mucho la clasificación.

## Español + English

El modo bilingüe intenta detectar si un fragmento final contiene más señales de español o de inglés. Si detecta un cambio sostenido, reinicia el reconocimiento con el idioma correspondiente.

La Web Speech API solo acepta un idioma BCP-47 por instancia de reconocimiento, por lo que el cambio automático es una aproximación y depende de la calidad del reconocimiento que ofrezca el navegador.

Para máxima precisión, si toda la clase está en un único idioma elegí directamente Español o English.

## Segundo plano y pantalla bloqueada

La PWA usa varios recursos para intentar mantener una sesión estable:
- Wake Lock para evitar el bloqueo automático cuando el navegador lo permite.
- Media Session.
- un audio silencioso muy pequeño durante la grabación;
- guardado de audio por fragmentos en IndexedDB;
- guardado automático del texto;
- recuperación del borrador.

Aun así, una web/PWA no puede obligar a iOS a mantener la captura del micrófono si WebKit decide suspenderla al bloquear la pantalla o poner la aplicación en segundo plano.

Si necesitás que la grabación continúe de forma garantizada con el iPhone bloqueado, hay que convertir el proyecto en una app nativa para iOS y usar AVAudioSession con el modo de audio de fondo. Eso requiere macOS + Xcode para compilar e instalar la app.

## Privacidad

- No hay backend propio.
- Texto, notas, clasificaciones e historial se almacenan localmente.
- Los fragmentos de audio temporales se guardan en IndexedDB durante la sesión.
- Al finalizar, se genera un archivo de audio descargable.
- SpeechRecognition puede usar servicios del navegador y no necesariamente funciona offline.
