const products = [
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

const materialContentPages = products.map((item) => ({
  page_content: [
    `# Material Name: ${item.name}`,
    `## Catalog Number: ${item.code}`,
    `## Material Type: ${item.material}`,
    `## Product Type: ${item.type}`,
    `## Dominant color: ${item.color}`,
    `## Facing finish: ${item.finish}`,
    `## General applications: ${item.applications.join(", ")}`,
  ].join("\n"),
}));

module.exports = {
  products,
  materialContentPages,
};
