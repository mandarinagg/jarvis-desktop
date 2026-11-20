export interface Recipe {
  name: string;
  minutes: number;
}

export function listRecipes(): Recipe[] {
  return [
    { name: "Tarta de verduras", minutes: 50 },
    { name: "Milanesas al horno", minutes: 35 },
  ];
}
