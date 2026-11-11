// Seven-segment LED digits drawn as inline SVG, like a taxi meter's display.
// Unlit segments stay faintly visible; lit ones glow (styles in meter.css).

import { ledCells, litSegments } from "./format";

const SVG_NS = "http://www.w3.org/2000/svg";
const SHAPES: Record<string, string> = {
  a: "11,4 41,4 45,8 41,12 11,12 7,8",
  b: "39,11 43,7 47,11 47,40 43,44 39,40",
  c: "39,50 43,46 47,50 47,79 43,83 39,79",
  d: "11,82 41,82 45,86 41,90 11,90 7,86",
  e: "5,50 9,46 13,50 13,79 9,83 5,79",
  f: "5,11 9,7 13,11 13,40 9,44 5,40",
  g: "11,41 41,41 45,45 41,49 11,49 7,45",
};

function digit(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 58 94");
  svg.setAttribute("class", "seg-digit");
  svg.setAttribute("aria-hidden", "true");
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("transform", "skewX(-7) translate(8 0)");
  for (const [name, points] of Object.entries(SHAPES)) {
    const p = document.createElementNS(SVG_NS, "polygon");
    p.setAttribute("points", points);
    p.dataset.seg = name;
    g.appendChild(p);
  }
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", "50");
  dot.setAttribute("cy", "86");
  dot.setAttribute("r", "4");
  dot.dataset.seg = "dp";
  g.appendChild(dot);
  svg.appendChild(g);
  return svg;
}

// Shows `text` (digits, '-', ' ', '.') in `el`, reusing digit SVGs so lit
// segments animate instead of the whole display being rebuilt.
export function showLed(el: HTMLElement, text: string): void {
  const cells = ledCells(text);
  while (el.children.length < cells.length) el.appendChild(digit());
  while (el.children.length > cells.length) el.lastChild!.remove();
  cells.forEach((cell, i) => {
    const lit = litSegments(cell.ch);
    for (const p of el.children[i]!.querySelectorAll<SVGElement>("[data-seg]")) {
      const seg = p.dataset.seg!;
      p.classList.toggle("on", seg === "dp" ? cell.dot : lit.includes(seg));
    }
  });
  el.setAttribute("aria-label", text.replace(/^0+(?=\d)/, ""));
}
