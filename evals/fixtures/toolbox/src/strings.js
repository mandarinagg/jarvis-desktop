/** Pone en mayúscula la primera letra de un texto. */
export function capitalize(text) {
  if (!text) return text;
  return text[0].toUpperCase() + text.slice(1);
}
