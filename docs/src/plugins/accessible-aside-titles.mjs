/** Keep visible callout titles in copied HTML and use them to name their asides. */
export default function accessibleAsideTitles() {
  return (tree) => {
    const ids = new Set();
    const asides = [];
    function visit(node) {
      if (node.type === 'element') {
        if (node.properties?.id) ids.add(node.properties.id);
        if (node.tagName === 'aside') asides.push(node);
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(tree);

    let sequence = 0;
    for (const aside of asides) {
      const title = aside.children.find((node) =>
        node.type === 'element' &&
        [].concat(node.properties?.className ?? []).includes('starlight-aside__title')
      );
      if (!title) continue;

      if (!title.properties.id) {
        let id;
        do { id = `fm-aside-title-${++sequence}`; } while (ids.has(id));
        title.properties.id = id;
        ids.add(id);
      }
      delete title.properties.ariaHidden;
      delete aside.properties.ariaLabel;
      aside.properties.ariaLabelledBy = [title.properties.id];
      for (const child of title.children) {
        if (child.type === 'element' && child.tagName === 'svg') {
          child.properties.ariaHidden = 'true';
        }
      }
    }
  };
}
