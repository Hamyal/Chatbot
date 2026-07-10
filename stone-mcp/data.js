// Self-contained stone catalog (mirrors stone-api/mockData.js).
// The MCP server carries its own data so it can be deployed alone,
// with no dependency on the REST API being live.

export const products = [
  {
    code: "M608",
    name: "Absolute Black Granite",
    material: "granite",
    type: "slab",
    color: "black",
    finish: "polished",
    applications: ["indoor", "outdoor", "paving"],
  },
  {
    code: "M742",
    name: "Carrara White Marble",
    material: "marble",
    type: "slab",
    color: "white",
    finish: "honed",
    applications: ["indoor", "flooring", "wall"],
  },
  {
    code: "M877",
    name: "Thassos White Marble",
    material: "marble",
    type: "tile",
    color: "white",
    finish: "polished",
    applications: ["indoor", "bathroom", "wall"],
  },
  {
    code: "M910",
    name: "Silver Travertine",
    material: "travertine",
    type: "tile",
    color: "gray",
    finish: "tumbled",
    applications: ["outdoor", "paving", "landscape"],
  },
];

export const ALLOWED_TYPES = new Set(["slab", "tile", "block"]);
export const ALLOWED_MATERIALS = new Set([
  "granite",
  "marble",
  "travertine",
  "limestone",
  "quartz",
]);

// Same tokenization + filtering the REST API uses, so results match.
export function searchProducts({ query = "", material = "", type = "" }) {
  let searchQuery = String(query);
  let materialFilter = String(material).toLowerCase().trim();
  let typeFilter = String(type).toLowerCase().trim();

  // If a caller puts a use-case (e.g. "paving") in type/material, fold it
  // back into the free-text query instead of using it as an exact filter.
  if (typeFilter && !ALLOWED_TYPES.has(typeFilter)) {
    searchQuery += ` ${typeFilter}`;
    typeFilter = "";
  }
  if (materialFilter && !ALLOWED_MATERIALS.has(materialFilter)) {
    searchQuery += ` ${materialFilter}`;
    materialFilter = "";
  }

  const stop = ["find", "show", "get", "for", "with", "the", "and", "stone"];
  const tokens = searchQuery
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .map((t) => (t.endsWith("s") ? t.slice(0, -1) : t))
    .filter((t) => !stop.includes(t))
    .filter((t) => t.length > 1);

  return products.filter((item) => {
    const apps = Array.isArray(item.applications)
      ? item.applications.join(" ")
      : "";
    const haystack =
      `${item.name} ${item.color} ${item.material} ${item.type} ${item.finish} ${apps}`.toLowerCase();
    const queryMatch =
      !tokens.length || tokens.every((token) => haystack.includes(token));
    const materialMatch = !materialFilter || item.material === materialFilter;
    const typeMatch = !typeFilter || item.type === typeFilter;
    return queryMatch && materialMatch && typeMatch;
  });
}

export function getProductByCode(code) {
  const wanted = String(code || "").trim().toUpperCase();
  return products.find((p) => p.code.toUpperCase() === wanted) || null;
}
