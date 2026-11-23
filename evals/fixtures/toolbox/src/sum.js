/** Suma los enteros de `from` a `to`, ambos incluidos. */
export function sumRange(from, to) {
  let total = 0;
  for (let i = from; i < to; i++) total += i;
  return total;
}
