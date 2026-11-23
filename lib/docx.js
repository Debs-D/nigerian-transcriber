import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { formatTimestamp, speakerLabel } from './format.js';

export async function buildDocx({ title, subtitle, segments, speakerNames = {}, timestamps = true }) {
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title || 'Transcript')] }),
  ];
  if (subtitle) {
    children.push(
      new Paragraph({ spacing: { after: 300 }, children: [new TextRun({ text: subtitle, italics: true, color: '666666' })] })
    );
  }

  for (const seg of segments) {
    const runs = [];
    if (timestamps) runs.push(new TextRun({ text: `[${formatTimestamp(seg.start)}] `, color: '777777' }));
    const label = speakerLabel(seg.speaker, speakerNames);
    if (label) runs.push(new TextRun({ text: `${label}: `, bold: true }));
    // A segment may hold several paragraphs (clean version); the first carries the label.
    const [first, ...rest] = String(seg.text ?? '').split(/\n\s*\n/);
    runs.push(new TextRun(first));
    children.push(new Paragraph({ spacing: { after: 200 }, children: runs }));
    for (const para of rest) children.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun(para)] }));
  }

  const doc = new Document({
    creator: 'Transcriber',
    title: title || 'Transcript',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
