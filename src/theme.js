// Read theme colours (from CSS variables) as [r, g, b] in 0-255, so canvases follow the page theme.
export function cssColor(expr) {
  const el = document.createElement('span');
  el.style.color = expr;
  document.body.appendChild(el);
  const rgb = getComputedStyle(el).color.match(/[\d.]+/g).slice(0, 3).map(Number);
  el.remove();
  return rgb;
}

export const themeColors = () => ({
  bg: cssColor('var(--bg)'),
  accentBg: cssColor('var(--accent-bg)'),
  text: cssColor('var(--text)'),
  textLight: cssColor('var(--text-light)'),
  border: cssColor('var(--border)'),
  primary: cssColor('var(--primary)'),
  secondary: cssColor('var(--secondary)'),
  tertiary: cssColor('var(--tertiary)'),
});
