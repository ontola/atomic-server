/** Invented pages for the importer tests and the e2e spec. */

const page = (head: string, body = '<p>Hello</p>') =>
  `<!doctype html><html><head><title>Test page</title>${head}</head><body>${body}</body></html>`;

export const recipePage = page(`
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Recipe","name":"Pannenkoeken",
 "description":"Dunne Hollandse pannenkoeken.","image":["https://example.test/pannenkoek.jpg"],
 "prepTime":"PT10M","cookTime":"PT20M","recipeYield":"4 porties",
 "recipeIngredient":["250 g bloem","500 ml melk","2 eieren"],
 "recipeInstructions":[{"@type":"HowToStep","text":"Meng alles."},{"@type":"HowToStep","text":"Bak in de pan."}]}
</script>`);

export const eventPage = page(`
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Event","name":"Open dag &amp; borrel",
 "startDate":"2027-03-05T16:00:00+01:00","endDate":"2027-03-05T20:00:00+01:00",
 "location":{"@type":"Place","name":"Buurthuis","address":{"@type":"PostalAddress","streetAddress":"Dorpsstraat 1","addressLocality":"Utrecht"}},
 "description":"Kom langs."}
</script>`);

export const openGraphPage = page(`
<meta property="og:title" content="Fietsen in de winter">
<meta property="og:description" content="Tips voor koude ritten.">
<meta property="og:image" content="https://example.test/fiets.jpg">
<meta property="og:type" content="article">
<link rel="canonical" href="https://example.test/fietsen/?utm_source=x#top">`);

export const barePage = page(
  '',
  '<h1>Niets</h1><p>Alleen tekst, geen metadata.</p><script>var x=1</script>',
);

export const graphPage = page(`
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"WebSite","@id":"https://example.test/#site","name":"Voorbeeld"},
 {"@type":"Organization","@id":"https://example.test/#org","name":"Voorbeeld BV"},
 {"@type":"BreadcrumbList","itemListElement":[]},
 {"@type":"WebPage","@id":"https://example.test/post","mainEntity":{"@id":"https://example.test/post#article"}},
 {"@type":"BlogPosting","@id":"https://example.test/post#article","headline":"Zes weken later",
  "description":"Een terugblik.","articleBody":"Het begon in <b>mei</b>.","datePublished":"2026-06-01T08:00:00Z",
  "author":{"@type":"Person","name":"Sanne"}}
]}
</script>`);
