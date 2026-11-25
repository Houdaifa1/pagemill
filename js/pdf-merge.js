import { addPreviewWatermarks, selectPreviewPageIndexes } from './preview.js?v=20261125-1';

function formNodes(fields, context, { PDFArray, PDFDict, PDFName }) {
  const nodes = new Set();
  const pending = fields?.asArray() || [];
  while (pending.length) {
    const field = context.lookup(pending.pop(), PDFDict);
    if (nodes.has(field)) continue;
    nodes.add(field);
    const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) pending.push(...kids.asArray());
  }
  return nodes;
}

function mergeFormResources(sourceResources, resources, copier, { PDFDict, PDFName }) {
  const renamedFonts = new Map();
  for (const [category, value] of sourceResources?.entries() || []) {
    const entries = sourceResources.context.lookup(value);
    if (!(entries instanceof PDFDict)) {
      if (!resources.has(category)) resources.set(category, copier.copy(value));
      continue;
    }
    let target = resources.lookupMaybe(category, PDFDict);
    if (!target) {
      target = resources.context.obj({});
      resources.set(category, target);
    }
    for (const [name, ref] of entries.entries()) {
      let unique = name;
      for (let suffix = 2; target.has(unique) || (unique !== name && entries.has(unique)); suffix++) {
        unique = PDFName.of(`${name.decodeText()}_${suffix}`);
      }
      target.set(unique, copier.copy(ref));
      if (unique !== name && category === PDFName.of('Font')) renamedFonts.set(name, unique);
    }
  }
  return renamedFonts;
}

function copyForm(sourceForm, nodes, outputForm, usedRootNames, copier, PDFLib) {
  const { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFString } = PDFLib;
  const key = PDFName.of;
  const fields = sourceForm.lookupMaybe(key('Fields'), PDFArray)?.asArray() || [];
  const roots = fields.map((ref) => sourceForm.context.lookup(ref, PDFDict));
  const rootNames = roots.map((root) => root.lookupMaybe(key('T'), PDFString, PDFHexString)?.decodeText());
  const reserved = new Set(rootNames);
  const renamedRoots = new Map();
  for (const name of reserved) {
    if (name === undefined || !usedRootNames.has(name)) continue;
    let unique = name;
    for (let suffix = 2; reserved.has(unique) || usedRootNames.has(unique); suffix++) {
      unique = `${name}+${suffix}`;
    }
    reserved.add(unique);
    renamedRoots.set(name, unique);
  }
  // Acrobat scripts can address fields by name. Renaming a scripted form could
  // silently redirect its actions to an earlier document's fields.
  if (renamedRoots.size && [...nodes].some((node) => node.has(key('AA')) || node.has(key('A')))) {
    throw new Error('some scripted fields have names already used by an earlier PDF.');
  }

  const renamedFonts = mergeFormResources(
    sourceForm.lookupMaybe(key('DR'), PDFDict), outputForm.lookup(key('DR'), PDFDict), copier, PDFLib
  );
  const allFields = outputForm.lookup(key('Fields'), PDFArray);
  for (const [index, root] of roots.entries()) {
    const copied = copier.copy(root);
    const name = rootNames[index];
    if (renamedRoots.has(name)) copied.set(key('T'), PDFHexString.fromText(renamedRoots.get(name)));
    for (const setting of ['DA', 'Q']) {
      const value = sourceForm.get(key(setting));
      if (!copied.has(key(setting)) && value) copied.set(key(setting), copier.copy(value));
    }
    if (name !== undefined) usedRootNames.add(renamedRoots.get(name) || name);
    allFields.push(copier.copy(fields[index]));
  }

  const copyDefault = !outputForm.has(key('DA')) && sourceForm.has(key('DA'));
  if (copyDefault) {
    // The form-level fallback belongs to the first source that defines one.
    // Explicit root defaults above keep every later source self-contained.
    outputForm.set(key('DA'), copier.copy(sourceForm.get(key('DA'))));
  }

  if (renamedFonts.size) {
    const copies = Array.from(nodes, (node) => copier.copy(node));
    if (copyDefault) copies.push(outputForm);
    for (const copied of copies) {
      const appearance = copied.lookupMaybe(key('DA'), PDFString, PDFHexString)?.decodeText();
      if (!appearance) continue;
      const updated = appearance.replace(/\/([^\s()[\]<>/{%}]+)(\s+[+-]?(?:\d+\.?\d*|\.\d+)\s+Tf\b)/g,
        (match, name, operands) => {
          const renamed = renamedFonts.get(key(name));
          return renamed ? `${renamed}${operands}` : match;
        });
      if (updated !== appearance) copied.set(key('DA'), PDFString.of(updated));
    }
  }
  if (sourceForm.lookupMaybe(key('NeedAppearances'), PDFBool)?.asBoolean()) {
    outputForm.set(key('NeedAppearances'), PDFBool.True);
  }
  const calculationOrder = sourceForm.lookupMaybe(key('CO'), PDFArray);
  if (calculationOrder) {
    const order = outputForm.lookup(key('CO'), PDFArray);
    for (const field of calculationOrder.asArray()) order.push(copier.copy(field));
  }
}

function mergeLayers(sourceLayers, output, copier, { PDFArray, PDFDict, PDFName }) {
  const key = PDFName.of;
  const layers = copier.copy(sourceLayers);
  const groups = layers.lookup(key('OCGs'), PDFArray).asArray();
  let combined = output.catalog.lookupMaybe(key('OCProperties'), PDFDict);
  if (!combined) {
    combined = output.context.obj({ OCGs: [], D: { BaseState: 'ON' }, Configs: [] });
    output.catalog.set(key('OCProperties'), combined);
  }
  for (const group of groups) combined.lookup(key('OCGs'), PDFArray).push(group);

  // Expand each document's base state into settings for its own groups. A
  // source's hidden layers must stay hidden without affecting any other PDF.
  const expand = (configuration) => {
    const on = new Set(configuration.lookupMaybe(key('ON'), PDFArray)?.asArray());
    const off = new Set(configuration.lookupMaybe(key('OFF'), PDFArray)?.asArray());
    const base = configuration.get(key('BaseState')) || key('ON');
    if (base !== key('Unchanged')) {
      for (const group of groups) {
        if (!on.has(group) && !off.has(group)) (base === key('OFF') ? off : on).add(group);
      }
    }
    return { on: [...on], off: [...off] };
  };
  const defaults = layers.lookup(key('D'), PDFDict);
  const mergedDefaults = combined.lookup(key('D'), PDFDict);
  const { on, off } = expand(defaults);
  for (const [type, entries] of [
    ['ON', on], ['OFF', off], ['Order', defaults.lookupMaybe(key('Order'), PDFArray)?.asArray() || groups],
    ...['AS', 'RBGroups', 'Locked'].map((type) => [type, defaults.lookupMaybe(key(type), PDFArray)?.asArray() || []]),
  ]) {
    if (!entries.length) continue;
    const target = mergedDefaults.lookupMaybe(key(type), PDFArray) || output.context.obj([]);
    for (const entry of entries) target.push(entry);
    mergedDefaults.set(key(type), target);
  }
  for (const ref of layers.lookupMaybe(key('Configs'), PDFArray)?.asArray() || []) {
    const config = output.context.lookup(ref, PDFDict);
    const { on, off } = expand(config);
    config.set(key('BaseState'), key('Unchanged'));
    config.set(key('ON'), output.context.obj(on));
    config.set(key('OFF'), output.context.obj(off));
    combined.lookup(key('Configs'), PDFArray).push(ref);
  }
}

function pageDestinations(source, { PDFArray, PDFDict, PDFHexString, PDFName, PDFString }) {
  const key = PDFName.of;
  const destinations = new Map();
  const visited = new Set();
  const names = source.catalog.lookupMaybe(key('Names'), PDFDict);
  const tree = names?.lookupMaybe(key('Dests'), PDFDict);
  const pending = tree ? [tree] : [];
  const legacy = source.catalog.lookupMaybe(key('Dests'), PDFDict);
  for (const [name, value] of legacy?.entries() || []) destinations.set(name.decodeText(), value);
  while (pending.length) {
    const branch = pending.pop();
    if (visited.has(branch)) continue;
    visited.add(branch);
    const named = branch.lookupMaybe(key('Names'), PDFArray);
    for (let index = 0; named && index + 1 < named.size(); index += 2) {
      const name = named.lookup(index, PDFString, PDFHexString).decodeText();
      destinations.set(name, named.get(index + 1));
    }
    const kids = branch.lookupMaybe(key('Kids'), PDFArray);
    for (const ref of kids?.asArray() || []) pending.push(source.context.lookup(ref, PDFDict));
  }
  return destinations;
}

function copyPageLinks(annotation, destinations, copier, { PDFArray, PDFDict, PDFHexString, PDFName, PDFString }) {
  const key = PDFName.of;
  const action = annotation.lookupMaybe(key('A'), PDFDict);
  const isLocalAction = action?.get(key('S')) === key('GoTo');
  const container = isLocalAction ? action : annotation;
  const entry = isLocalAction ? key('D') : key('Dest');
  const name = container.lookup(entry);
  if (!(name instanceof PDFName || name instanceof PDFString || name instanceof PDFHexString)) return;
  const destination = annotation.context.lookup(destinations.get(name.decodeText()));
  const target = destination instanceof PDFDict ? destination.lookup(key('D')) : destination;
  if (target instanceof PDFArray) copier.copy(container).set(entry, copier.copy(target));
}

async function assemblePdf(files, PDFLib, onProgress, coverFileCount = 0) {
  if (files.length < 2) throw new Error('Choose at least two PDFs.');
  const { PDFArray, PDFDict, PDFDocument, PDFInvalidObject, PDFName, PDFObjectCopier, PDFPage, PDFPageLeaf } = PDFLib;
  const key = PDFName.of;
  const output = await PDFDocument.create();
  const outputForm = output.context.obj({ Fields: [], DR: {}, CO: [] });
  const usedRootNames = new Set();
  let coverPageCount = 0;
  output.setCreator('Bindery');

  for (const [index, file] of files.entries()) {
    onProgress(index, file.name);
    let source;
    try {
      // pdf-lib needs to get past encrypted object streams to see the trailer's
      // encryption flag. Anything it could not parse is rejected below.
      source = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
    } catch (error) {
      const reason = /is encrypted/i.test(error.message) ? 'is password-protected or encrypted.' : 'could not be opened as a valid PDF.';
      throw new Error(`${file.name} ${reason}`);
    }

    try {
      const objects = source.context.enumerateIndirectObjects();
      if (objects.some(([, object]) => object instanceof PDFInvalidObject)) {
        throw new Error('could not be opened as a valid PDF.');
      }
      const sourceForm = source.catalog.lookupMaybe(key('AcroForm'), PDFDict);
      if (sourceForm?.has(key('XFA'))) throw new Error('contains an XFA form and needs to stay in its own PDF.');
      const openAction = source.catalog.lookup(key('OpenAction'));
      const scripts = source.catalog.lookupMaybe(key('Names'), PDFDict)?.has(key('JavaScript')) ||
        source.catalog.lookupMaybe(key('AA'), PDFDict)?.keys().length ||
        (openAction instanceof PDFDict && openAction.get(key('S')) === key('JavaScript'));
      if (scripts) {
        throw new Error('uses document-level scripts and needs to stay in its own PDF.');
      }
      const fields = sourceForm?.lookupMaybe(key('Fields'), PDFArray);
      const nodes = formNodes(fields, source.context, PDFLib);
      const signed = objects.some(([, object]) => object instanceof PDFDict && (
        object.get(key('Type')) === key('Sig') || (object.has(key('ByteRange')) && object.has(key('Contents'))) ||
        (object.get(key('FT')) === key('Sig') && object.has(key('V')))
      ));
      if (signed) throw new Error('has a digital signature that would become invalid in the merged PDF.');

      const pages = source.getPages();
      if (!pages.length) throw new Error('contains no pages.');
      if (index < coverFileCount) coverPageCount += pages.length;
      const copier = PDFObjectCopier.for(source.context, output.context);
      const layers = source.catalog.lookupMaybe(key('OCProperties'), PDFDict);
      if (layers) mergeLayers(layers, output, copier, PDFLib);
      const destinations = pageDestinations(source, PDFLib);
      for (const page of pages) {
        // Use the copied page reference so every widget and link points to the
        // actual page in the output, including cross-page links and widgets.
        const ref = copier.copy(page.ref);
        const leaf = output.context.lookup(ref, PDFPageLeaf);
        output.addPage(PDFPage.of(leaf, ref, output));
        for (const annot of page.node.Annots()?.asArray() || []) {
          const annotation = source.context.lookupMaybe(annot, PDFDict);
          if (!annotation) continue;
          if (annotation.get(key('Subtype')) === key('Widget') && !nodes.has(annotation)) {
            throw new Error('has a fillable field missing from its form data.');
          }
          if (destinations.size) copyPageLinks(annotation, destinations, copier, PDFLib);
        }
      }
      if (fields?.size()) copyForm(sourceForm, nodes, outputForm, usedRootNames, copier, PDFLib);
    } catch (error) {
      throw new Error(`${file.name} ${error.message}`);
    }
  }

  if (outputForm.lookup(key('Fields'), PDFArray).size()) {
    if (!outputForm.lookup(key('CO'), PDFArray).size()) outputForm.delete(key('CO'));
    output.catalog.set(key('AcroForm'), output.context.register(outputForm));
  }
  return { output, coverPageCount };
}

export async function mergePdfFiles(files, PDFLib, onProgress = () => {}) {
  const { output } = await assemblePdf(files, PDFLib, onProgress);
  return output.save({ updateFieldAppearances: false });
}

// Work on the staged document only after the full PDF has been saved. Prune
// form widgets from omitted pages so a shared field cannot pull those pages
// into the preview when the selected pages are copied.
async function copyPreview(source, indexes, PDFLib) {
  const { PDFArray, PDFDict, PDFDocument, PDFName, PDFObjectCopier, PDFPage, PDFPageLeaf } = PDFLib;
  const key = PDFName.of;
  const pages = indexes.map((index) => source.getPage(index));
  const selected = new Set(pages.map((page) => page.ref));
  const widgets = new Set();
  for (const page of pages) {
    for (const ref of page.node.Annots()?.asArray() || []) {
      const annotation = source.context.lookupMaybe(ref, PDFDict);
      if (!annotation) continue;
      if (annotation.get(key('Subtype')) === key('Widget')) widgets.add(annotation);
      const action = annotation.lookupMaybe(key('A'), PDFDict);
      const localAction = action?.get(key('S')) === key('GoTo');
      const owner = localAction ? action : annotation;
      const entry = localAction ? key('D') : key('Dest');
      const destination = owner.lookup(entry);
      if (destination instanceof PDFArray && !selected.has(destination.get(0))) {
        if (localAction) annotation.delete(key('A'));
        else annotation.delete(entry);
      }
    }
  }

  const form = source.catalog.lookupMaybe(key('AcroForm'), PDFDict);
  const roots = form?.lookupMaybe(key('Fields'), PDFArray);
  const kept = new Map();
  const prune = (ref) => {
    const field = source.context.lookup(ref, PDFDict);
    if (kept.has(field)) return kept.get(field);
    kept.set(field, false);
    const kids = field.lookupMaybe(key('Kids'), PDFArray);
    const children = kids?.asArray().filter(prune) || [];
    const keep = widgets.has(field) || children.length > 0;
    if (keep && kids) field.set(key('Kids'), source.context.obj(children));
    kept.set(field, keep);
    return keep;
  };
  const retained = roots?.asArray().filter(prune) || [];
  if (retained.length) {
    form.set(key('Fields'), source.context.obj(retained));
    const order = form.lookupMaybe(key('CO'), PDFArray);
    if (order) form.set(key('CO'), source.context.obj(order.asArray().filter((ref) => kept.get(source.context.lookup(ref)))));
  }

  for (const page of source.getPages()) {
    if (!selected.has(page.ref)) source.context.delete(page.ref);
  }
  const preview = await PDFDocument.create();
  const copier = PDFObjectCopier.for(source.context, preview.context);
  for (const page of pages) {
    const ref = copier.copy(page.ref);
    preview.addPage(PDFPage.of(preview.context.lookup(ref, PDFPageLeaf), ref, preview));
  }
  if (retained.length) preview.catalog.set(key('AcroForm'), copier.copy(source.catalog.get(key('AcroForm'))));
  const layers = source.catalog.get(key('OCProperties'));
  if (layers) preview.catalog.set(key('OCProperties'), copier.copy(layers));
  await addPreviewWatermarks(preview, PDFLib);
  return preview.save({ updateFieldAppearances: false });
}

export async function buildPdfMergeOutput(files, PDFLib, {
  includeFull = true, createPreview = false, coverFileCount = 0, previewManualCount = null,
} = {}, onProgress = () => {}) {
  const { output, coverPageCount } = await assemblePdf(files, PDFLib, onProgress, coverFileCount);
  const pdfBytes = includeFull ? await output.save({ updateFieldAppearances: false }) : null;
  const manualCount = previewManualCount === null ? null : Math.max(3, Math.floor(Number(previewManualCount) || 3));
  const indexes = createPreview ? selectPreviewPageIndexes(output.getPageCount(), coverPageCount, manualCount) : [];
  const previewBytes = indexes.length ? await copyPreview(output, indexes, PDFLib) : null;
  return { pdfBytes, previewBytes };
}
