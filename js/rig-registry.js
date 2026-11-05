// Gemeinsame Ablage für bekannte Skelette (z. B. das der Wolfsspinne).
// Bewusst eine WeakMap statt userData: userData würde beim GLB-Export mitgeschrieben.
export const RIGS = new WeakMap();
