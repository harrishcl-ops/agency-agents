// JSON schema for Claude structured outputs. Structured outputs reject
// recursive schemas, so nodes are a flat list linked by `parent`.

const nullable = (schema: Record<string, unknown>) => ({
  anyOf: [schema, { type: "null" }],
});

const color = { type: "string", description: "Hex color #RRGGBB or #RRGGBBAA" };

const textStyle = {
  type: "object",
  additionalProperties: false,
  required: [
    "content",
    "fontFamily",
    "fontWeight",
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "color",
    "align",
    "italic",
    "decoration",
  ],
  properties: {
    content: { type: "string" },
    fontFamily: { type: "string" },
    fontWeight: { type: "integer" },
    fontSize: { type: "number" },
    lineHeight: nullable({ type: "number" }),
    letterSpacing: nullable({ type: "number" }),
    color,
    align: { type: "string", enum: ["left", "center", "right", "justify"] },
    italic: { type: "boolean" },
    decoration: { type: "string", enum: ["none", "underline", "strikethrough"] },
  },
};

const shadow = {
  type: "object",
  additionalProperties: false,
  required: ["color", "x", "y", "blur", "spread"],
  properties: {
    color,
    x: { type: "number" },
    y: { type: "number" },
    blur: { type: "number" },
    spread: { type: "number" },
  },
};

const gradient = {
  type: "object",
  additionalProperties: false,
  required: ["angle", "stops"],
  properties: {
    angle: { type: "number", description: "CSS linear-gradient angle in degrees" },
    stops: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["color", "position"],
        properties: { color, position: { type: "number" } },
      },
    },
  },
};

const node = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "parent",
    "type",
    "name",
    "x",
    "y",
    "w",
    "h",
    "fill",
    "gradient",
    "stroke",
    "strokeWidth",
    "radius",
    "shadow",
    "opacity",
    "layout",
    "text",
    "svg",
  ],
  properties: {
    id: { type: "string" },
    parent: { type: "string", description: '"root" for top-level elements' },
    type: {
      type: "string",
      enum: ["frame", "text", "image", "icon", "rectangle", "ellipse", "line"],
    },
    name: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    w: { type: "number" },
    h: { type: "number" },
    fill: nullable(color),
    gradient: nullable(gradient),
    stroke: nullable(color),
    strokeWidth: nullable({ type: "number" }),
    radius: nullable({ type: "number" }),
    shadow: nullable(shadow),
    opacity: nullable({ type: "number" }),
    layout: { type: "string", enum: ["row", "column", "none"] },
    text: nullable(textStyle),
    svg: nullable({ type: "string" }),
  },
};

export const CORRECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["updates", "additions", "deletions"],
  properties: {
    updates: { type: "array", items: node },
    additions: { type: "array", items: node },
    deletions: { type: "array", items: { type: "string" } },
  },
} as const;

export const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["screenName", "background", "nodes"],
  properties: {
    screenName: { type: "string" },
    background: color,
    nodes: { type: "array", items: node },
  },
} as const;
