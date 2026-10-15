export function svgTextClippingScene(content: string, offset = { x: 0, y: 0 }): string {
  return `<style>body{margin:0}svg{display:block;font:20px monospace}</style>
    <main style="transform:translate(${offset.x}px,${offset.y}px)">${content}</main>`;
}
