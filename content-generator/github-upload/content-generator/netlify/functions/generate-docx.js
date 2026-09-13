const { Document, Paragraph, TextRun, HeadingLevel, Packer, ExternalHyperlink, BorderStyle, UnderlineType, AlignmentType } = require('docx');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body' }) }; }

  const { agentName, month, posts, emails, videos } = body;

  function classifyType(p) {
    if (p.post_type === 'email') return 'email';
    if (p.post_type === 'video') return 'video';
    if (p.canva_link) return 'canva';
    return 'social';
  }

  function cleanEmailBody(text) {
    if (!text) return '';
    return text
      .replace(/---+\s*\n*VISUAL ASSETS[\s\S]*/i, '')
      .replace(/#+\s*VISUAL ASSETS[\s\S]*/i, '')
      .replace(/VISUAL ASSETS[\s\S]*/i, '')
      .replace(/\*\*Image Idea[\s\S]*/i, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function divider() {
    return new Paragraph({ border: { bottom: { color: 'E0DDD7', space: 1, value: BorderStyle.SINGLE, size: 4 } }, spacing: { after: 160 } });
  }

  function sectionHeading(text, color) {
    return new Paragraph({
      children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 22, color: color || '1B6840', characterSpacing: 60 })],
      spacing: { before: 560, after: 160 }
    });
  }

  function photoLink(fileId, label) {
    if (!fileId) return null;
    var downloadUrl = 'https://drive.google.com/uc?export=download&id=' + fileId;
    var viewUrl = 'https://drive.google.com/file/d/' + fileId + '/view';
    return new Paragraph({
      children: [
        new TextRun({ text: (label || 'PHOTO') + ':  ', bold: true, size: 20, color: '555555' }),
        new ExternalHyperlink({ link: downloadUrl, children: [new TextRun({ text: '⬇ Download', size: 20, color: '1A4F8A', underline: { type: UnderlineType.SINGLE } })] }),
        new TextRun({ text: '   ', size: 20 }),
        new ExternalHyperlink({ link: viewUrl, children: [new TextRun({ text: '📁 View in Drive', size: 20, color: '555555', underline: { type: UnderlineType.SINGLE } })] })
      ],
      spacing: { before: 80, after: 60 }
    });
  }

  function buildItemBlock(item, index) {
    var paras = [];
    var type = classifyType(item);

    // Item title
    paras.push(new Paragraph({
      children: [new TextRun({ text: (index + 1) + '.  ' + (item.post_title || 'Untitled'), bold: true, size: 26 })],
      spacing: { before: 280, after: 100 }
    }));

    // Email: subject lines
    if (type === 'email') {
      var subjects = [];
      try { subjects = JSON.parse(item.subjects || '[]'); } catch(e) {}
      if (subjects.length) {
        paras.push(new Paragraph({ children: [new TextRun({ text: 'SUBJECT LINE OPTIONS', bold: true, size: 18, color: '9A9A90', characterSpacing: 40 })], spacing: { before: 60, after: 60 } }));
        subjects.forEach(function(s) {
          paras.push(new Paragraph({ children: [new TextRun({ text: '→  ' + s, size: 20, italics: true, color: '555555' })], spacing: { after: 40 } }));
        });
        paras.push(new Paragraph({ spacing: { after: 120 } }));
      }
    }

    // Copy text — clean email body first
    var copyText = type === 'email' ? cleanEmailBody(item.copy || '') : (item.copy || item.script || '').trim();
    copyText.split('\n').forEach(function(line) {
      if (line.trim()) {
        paras.push(new Paragraph({
          children: [new TextRun({ text: line.trim(), size: type === 'video' ? 21 : 23 })],
          spacing: { after: type === 'email' ? 80 : 60 }
        }));
      } else {
        paras.push(new Paragraph({ spacing: { after: 60 } }));
      }
    });

    // Photo link for social/canva posts
    if ((type === 'social' || type === 'canva') && item.selected_photo_id && !item.selected_photo_id.startsWith('[')) {
      var pl = photoLink(item.selected_photo_id, 'PHOTO');
      if (pl) paras.push(pl);
    }

    // Email attached photos
    if (type === 'email') {
      var emailPhotos = item.email_photos || [];
      if (!emailPhotos.length && item.selected_photo_id && item.selected_photo_id.startsWith('[')) {
        try { emailPhotos = JSON.parse(item.selected_photo_id); } catch(e) {}
      }
      if (emailPhotos.length) {
        paras.push(new Paragraph({ children: [new TextRun({ text: 'EMAIL PHOTOS:', bold: true, size: 20, color: '555555' })], spacing: { before: 100, after: 40 } }));
        emailPhotos.forEach(function(p, pi) {
          if (p.drive_file_id) {
            var pl2 = photoLink(p.drive_file_id, 'Photo ' + (pi + 1));
            if (pl2) paras.push(pl2);
          } else if (p.url) {
            paras.push(new Paragraph({
              children: [
                new TextRun({ text: 'Photo ' + (pi + 1) + ':  ', bold: true, size: 20, color: '555555' }),
                new ExternalHyperlink({ link: p.url, children: [new TextRun({ text: p.credit || 'View photo', size: 20, color: '1A4F8A', underline: { type: UnderlineType.SINGLE } })] })
              ],
              spacing: { after: 40 }
            }));
          }
        });
      }
    }

    // Canva link
    if (item.canva_link) {
      paras.push(new Paragraph({
        children: [
          new TextRun({ text: 'CANVA TEMPLATE:  ', bold: true, size: 20, color: '555555' }),
          new ExternalHyperlink({ link: item.canva_link, children: [new TextRun({ text: 'Open in Canva →', size: 20, color: '92600A', underline: { type: UnderlineType.SINGLE } })] })
        ],
        spacing: { before: 60, after: 100 }
      }));
    }

    paras.push(divider());
    return paras;
  }

  var allItems = (posts || []).concat(emails || []).concat(videos || []);
  var socialItems = allItems.filter(function(p){ return classifyType(p) === 'social'; });
  var emailItems = allItems.filter(function(p){ return classifyType(p) === 'email'; });
  var videoItems = allItems.filter(function(p){ return classifyType(p) === 'video'; });
  var canvaItems = allItems.filter(function(p){ return classifyType(p) === 'canva'; });

  var children = [
    new Paragraph({ children: [new TextRun({ text: agentName || 'Agent', bold: true, size: 48, color: '18181A' })], spacing: { after: 80 } }),
    new Paragraph({ children: [new TextRun({ text: month || '', size: 28, color: '52524E' })], spacing: { after: 60 } }),
    new Paragraph({ children: [new TextRun({ text: 'Publishing Instructions · Your Marketing Dude', size: 20, color: '9A9A90', italics: true })], spacing: { after: 400 } }),
    divider()
  ];

  if (socialItems.length) {
    children.push(sectionHeading('Social Posts (' + socialItems.length + ')', '1B6840'));
    socialItems.forEach(function(p, i) { buildItemBlock(p, i).forEach(function(x){ children.push(x); }); });
  }
  if (emailItems.length) {
    children.push(sectionHeading('Emails (' + emailItems.length + ')', '1A4F8A'));
    emailItems.forEach(function(p, i) { buildItemBlock(p, i).forEach(function(x){ children.push(x); }); });
  }
  if (videoItems.length) {
    children.push(sectionHeading('Video Scripts (' + videoItems.length + ')', '3730A3'));
    videoItems.forEach(function(p, i) { buildItemBlock(p, i).forEach(function(x){ children.push(x); }); });
  }
  if (canvaItems.length) {
    children.push(sectionHeading('Predesigned Canva Templates (' + canvaItems.length + ')', '92600A'));
    canvaItems.forEach(function(p, i) { buildItemBlock(p, i).forEach(function(x){ children.push(x); }); });
  }

  children.push(new Paragraph({ children: [new TextRun({ text: 'Created by Your Marketing Dude · yourmarketingdude.com', size: 18, color: 'B0ADA6', italics: true })], spacing: { before: 480 }, alignment: AlignmentType.CENTER }));

  try {
    const doc = new Document({ sections: [{ properties: { page: { size: { width: 12240, height: 15840 } } }, children }] });
    const buffer = await Packer.toBuffer(doc);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': 'attachment; filename="publishing-instructions.docx"' },
      body: buffer.toString('base64'),
      isBase64Encoded: true
    };
  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
