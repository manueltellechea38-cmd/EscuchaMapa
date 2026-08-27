# EscuchaMapa v3

PWA para grabar clases o conversaciones, transcribirlas en vivo y convertir el contenido en un resumen y un mapa conceptual simple.

## Cambios principales

- Interfaz más simple y unificada.
- Un solo texto principal y un cajón opcional con todo lo escuchado.
- Nueva sesión, borrar texto, deshacer último fragmento y borrar historial.
- Mejor manejo de duplicados.
- Hasta 3 alternativas de SpeechRecognition y selección por confianza.
- Filtro menos agresivo.
- Español, inglés y modo bilingüe.
- Contextual biasing con el tema cuando el navegador soporta `SpeechRecognition.phrases`.
- Mapa conceptual con ramas, frases de apoyo y conceptos relacionados.
- Botón para mejorar la transcripción con Whisper en el navegador al finalizar.
- Eliminado el audio silencioso de la v2 porque puede interferir con SpeechRecognition en iOS.
- `navigator.audioSession.type = "play-and-record"` cuando está disponible.
- Wake Lock mientras la app está visible y grabando.

## Segundo plano en iPhone

Una PWA no puede garantizar que iOS mantenga el micrófono activo con la pantalla bloqueada o cuando WebKit suspende la aplicación. Para una garantía real hay que crear una app iOS nativa con AVAudioSession y audio de fondo.

## Ejecutar

Con VS Code: clic derecho en `index.html` > `Open with Live Server`.

O:

```powershell
python -m http.server 5500
```