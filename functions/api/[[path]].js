// Die API läuft als Cloudflare-Pages-Funktion unter derselben Adresse wie die
// App. Das ist keine Kosmetik: Nur so ist das Sitzungs-Cookie ein
// Erst-Anbieter-Cookie und wird auch von Safari auf iOS akzeptiert.
// Nebeneffekt: CORS entfällt vollständig.
import { handle } from "../../api/router.js";

export const onRequest = (context) => handle(context.request, context.env);

