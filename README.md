# EscuchaMapa v3

PWA para grabar clases o conversaciones, transcribirlas en vivo y convertir el contenido en un resumen y un mapa conceptual simple.

## Cambios principales

- Interfaz más simple y unificada.
- Una sola pantalla principal de grabación.
- Un solo texto principal y un cajón opcional con todo lo escuchado.
- Nueva sesión, borrar texto, deshacer último fragmento y borrar historial.
- Mejor control de duplicados del reconocimiento.
- Hasta 3 alternativas de SpeechRecognition y selección por confianza.
- Filtro menos agresivo para no perder contenido útil.
- Español, inglés y modo bilingüe.
- Tema opcional para ayudar a priorizar vocabulario.
- Mapa conceptual basado en frases reales y conceptos relacionados.
- Se eliminó el audio silencioso de mantenimiento para evitar interferencias con el reconocimiento.
- Se intenta usar Audio Session de tipo play-and-record cuando el navegador lo permite.
- Wake Lock mientras la app está visible y grabando.

## Precisión

La transcripción en vivo usa SpeechRecognition del navegador. Su calidad depende del navegador, el sistema operativo, el micrófono, el ruido ambiente y la conexión en los navegadores que procesan la voz mediante servicios remotos.

## Pantalla bloqueada y segundo plano en iPhone

Una PWA no puede garantizar que iOS mantenga el micrófono capturando cuando la pantalla se bloquea o WebKit suspende la aplicación. EscuchaMapa intenta conservar la sesión mediante las APIs web disponibles, pero una garantía real requiere una aplicación nativa iOS con audio en segundo plano.

## Ejecutar localmente

Con Live Server:
1. Abrí la carpeta en VS Code.
2. Clic derecho en index.html.
3. Open with Live Server.

También podés usar:

```powershell
python -m http.server 5500
```

## Publicación

El proyecto está preparado para GitHub Pages desde la rama main.
