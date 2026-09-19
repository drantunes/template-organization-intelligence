import { crc32, deflateRawSync } from 'node:zlib';

export function officeArchive(entries: Record<string, string>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(text);
    const compressed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(data), 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export const docx = () =>
  officeArchive({
    'word/document.xml':
      '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Records policy</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Deadline</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Archivist</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Nine days</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Closing paragraph</w:t></w:r></w:p></w:body></w:document>',
  });
export const xlsx = () =>
  officeArchive({
    'xl/workbook.xml':
      '<workbook xmlns:r="relationships"><sheets><sheet name="Summary" r:id="a"/><sheet name="Details" r:id="b"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="a" Target="worksheets/overview.xml"/><Relationship Id="b" Target="worksheets/rules.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Owner</t></si><si><r><t>Retention </t></r><r><t>rule</t></r></si></sst>',
    'xl/worksheets/overview.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Summary only</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/rules.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Finance</t></is></c><c r="B2" t="inlineStr"><is><t>Keep receipts for eleven years</t></is></c></row><row r="3"><c r="A3"><f>SUM(1,2)</f><v>3</v></c><c r="B3"><f>UNSUPPORTED()</f></c><c r="C3" t="e"><f>1/0</f><v>#DIV/0!</v></c></row></sheetData></worksheet>',
  });

export function pdf(pages: string[]): Buffer {
  const objects = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [' + pages.map((_, i) => 4 + i * 2 + ' 0 R').join(' ') + '] /Count ' + pages.length + ' >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, text] of pages.entries()) {
    const stream = text ? 'BT /F1 12 Tf 50 700 Td (' + text + ') Tj ET' : '';
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ' +
        (5 + index * 2) +
        ' 0 R >>',
    );
    objects.push('<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream');
  }
  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(content));
    content += i + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  const xref = Buffer.byteLength(content);
  content +=
    'xref\n0 ' +
    objects.length +
    '\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map(offset => String(offset).padStart(10, '0') + ' 00000 n \n')
      .join('');
  content += 'trailer\n<< /Size ' + objects.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(content);
}

export function googleFixture() {
  let failed = false;
  let incomplete = false;
  const files = new Map<
    string,
    { id: string; name: string; mimeType: string; parent: string; content: Buffer; docs?: unknown }
  >();
  const calls: string[] = [];
  const methods: string[] = [];
  const request: typeof fetch = async (input, options) => {
    methods.push(options?.method ?? 'GET');
    const url = new URL(String(input));
    calls.push(url.href);
    if (failed) return new Response('', { status: 503 });
    if (url.hostname === 'docs.googleapis.com') {
      const id = url.pathname.split('/').at(-1)!;
      return Response.json(files.get(id)?.docs ?? {});
    }
    if (url.pathname === '/drive/v3/files') {
      const parent = url.searchParams.get('q')?.match(/^'([^']+)'/)?.[1];
      return Response.json({
        files: [...files.values()]
          .filter(file => file.parent === parent)
          .map(({ id, name, mimeType, content }) => ({ id, name, mimeType, size: String(content.length) })),
        incompleteSearch: incomplete,
      });
    }
    const id = url.pathname.split('/')[4]!;
    const file = files.get(decodeURIComponent(id));
    return file ? new Response(new Uint8Array(file.content)) : new Response('', { status: 404 });
  };
  return {
    files,
    request,
    calls,
    methods,
    setFailed(value: boolean) {
      failed = value;
    },
    setIncomplete(value: boolean) {
      incomplete = value;
    },
  };
}
