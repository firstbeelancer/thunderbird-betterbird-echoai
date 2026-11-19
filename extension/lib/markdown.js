/**
 * Безопасный рендер Markdown -> DOM (без вставки необработанного HTML).
 */

function appendInlineFormatted(parent, text) {
  const tokenRegex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      const em = document.createElement("em");
      em.textContent = token.slice(1, -1);
      parent.appendChild(em);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    }
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

export function renderMarkdownToFragment(markdown) {
  const frag = document.createDocumentFragment();
  const text = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trim().startsWith("```")) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    // Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length + 1, 5);
      const h = document.createElement(`h${level}`);
      appendInlineFormatted(h, headingMatch[2].trim());
      frag.appendChild(h);
      i++;
      continue;
    }

    // Blockquote
    if (line.trim().startsWith(">")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const bq = document.createElement("blockquote");
      appendInlineFormatted(bq, quoteLines.join(" "));
      frag.appendChild(bq);
      continue;
    }

    // Unordered list
    if (/^\s*[-*•]\s+/.test(line)) {
      const ul = document.createElement("ul");
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        const li = document.createElement("li");
        appendInlineFormatted(li, lines[i].replace(/^\s*[-*•]\s+/, ""));
        ul.appendChild(li);
        i++;
      }
      frag.appendChild(ul);
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const ol = document.createElement("ol");
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        const li = document.createElement("li");
        appendInlineFormatted(li, lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        ol.appendChild(li);
        i++;
      }
      frag.appendChild(ol);
      continue;
    }

    // Paragraph (group consecutive plain lines)
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("```") &&
      !/^#{1,4}\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith(">") &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    const p = document.createElement("p");
    paraLines.forEach((pl, idx) => {
      if (idx > 0) p.appendChild(document.createElement("br"));
      appendInlineFormatted(p, pl);
    });
    frag.appendChild(p);
  }

  return frag;
}
