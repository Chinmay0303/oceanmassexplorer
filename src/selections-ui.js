// Sidebar list of all selections (rectangles and curves of every diagram): select, style, show/hide, delete.
// All state lives in the panel; this only draws the list and forwards clicks to panel methods.
const STYLES = [['surface', 'Surface'], ['volume', 'Volume'], ['both', 'Surface + volume']];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function renderSelections(ul, panel) {
  ul.replaceChildren();
  if (!panel.items.length) {
    ul.append(el('li', 'empty', 'No selections yet. Pick Rectangle or Curve and draw in the diagram.'));
    return;
  }
  for (const it of panel.items) {
    const li = el('li', 'sel' + (it.id === panel.selectedId ? ' on' : '') + (it.pair !== panel.pairKey ? ' other' : ''));

    const name = el('button', 'name');
    const sw = el('span', 'sw');
    sw.style.background = `rgb(${it.color})`;
    name.append(sw, it.name);
    name.title = it.pair === panel.pairKey ? 'Select' : 'Select (switches the diagram)';
    name.onclick = () => panel.select(it.id);
    li.append(name);

    if (it.kind === 'rect') {
      const sel = el('select', 'style');
      sel.title = 'How this rectangle is drawn in 3D';
      sel.setAttribute('aria-label', 'Style');
      for (const [v, label] of STYLES) sel.add(new Option(label, v, false, v === it.style));
      sel.onchange = () => panel.setStyle(it.id, sel.value);
      li.append(sel);
    } else li.append(el('span'));

    const vis = el('input', 'vis');
    vis.type = 'checkbox';
    vis.checked = it.visible;
    vis.title = 'Show in the 3D view';
    vis.setAttribute('aria-label', 'Show');
    vis.onchange = () => panel.setVisible(it.id, vis.checked);
    li.append(vis);

    const del = el('button', 'del', '×');
    del.title = 'Delete';
    del.setAttribute('aria-label', 'Delete ' + it.name);
    del.onclick = () => panel.remove(it.id);
    li.append(del);

    ul.append(li);
  }
}
