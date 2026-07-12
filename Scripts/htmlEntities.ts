// Decode the handful of HTML/XML entities that can appear in element note
// content. Older notes were written through Handlebars' default escaping, so a
// name like "The Kid's Family" landed on disk as "The Kid&#x27;s Family". Every
// place that reads display text out of a note and uses it as a filename-lookup
// key, an API `name`/text value, or a [[wikilink]] must decode first, or the
// escaped form leaks into file lookups (which fail) and API writes (which store
// the escaped string verbatim). New notes are written unescaped (noEscape on the
// Handlebars compile sites), so this only has to repair notes already on disk.
//
// No new dependency: the five XML entities plus their numeric forms cover
// everything Handlebars.escapeExpression emits (& < > " ').
export function decodeHtmlEntities(input: string): string {
    if (!input || input.indexOf('&') === -1) return input;
    return input
        // Named forms
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        // Numeric forms (decimal and hex), e.g. &#x27; &#39; for apostrophe
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
        // Ampersand LAST so we don't turn "&amp;#x27;" into "'" (decode one layer only)
        .replace(/&amp;/g, '&');
}
