// Vietnamese typed for the legacy TCVN3 (ABC) fonts (.VnTime, .VnArial...: one byte per letter, read by AutoCAD
// through code page 1252 as Latin-1 characters: "MÆt b»ng tÇng 1" is "Mặt bằng tầng 1"). The fonts whose name ends in H
// (.VnTimeH, .VnArialH) show every letter as a capital. VNI fonts (two characters per toned letter) are not handled.

const PAIRS = [
  // a, ă, â
  ['µ', 'à'], ['¶', 'ả'], ['·', 'ã'], ['¸', 'á'], ['¹', 'ạ'],
  ['¨', 'ă'], ['»', 'ằ'], ['¼', 'ẳ'], ['½', 'ẵ'], ['¾', 'ắ'], ['Æ', 'ặ'],
  ['©', 'â'], ['Ç', 'ầ'], ['È', 'ẩ'], ['É', 'ẫ'], ['Ê', 'ấ'], ['Ë', 'ậ'],
  // e, ê
  ['Ì', 'è'], ['Î', 'ẻ'], ['Ï', 'ẽ'], ['Ð', 'é'], ['Ñ', 'ẹ'],
  ['ª', 'ê'], ['Ò', 'ề'], ['Ó', 'ể'], ['Ô', 'ễ'], ['Õ', 'ế'], ['Ö', 'ệ'],
  // i
  ['×', 'ì'], ['Ø', 'ỉ'], ['Ü', 'ĩ'], ['Ý', 'í'], ['Þ', 'ị'],
  // o, ô, ơ
  ['ß', 'ò'], ['á', 'ỏ'], ['â', 'õ'], ['ã', 'ó'], ['ä', 'ọ'],
  ['«', 'ô'], ['å', 'ồ'], ['æ', 'ổ'], ['ç', 'ỗ'], ['è', 'ố'], ['é', 'ộ'],
  ['¬', 'ơ'], ['ê', 'ờ'], ['ë', 'ở'], ['ì', 'ỡ'], ['í', 'ớ'], ['î', 'ợ'],
  // u, ư
  ['ï', 'ù'], ['ñ', 'ủ'], ['ò', 'ũ'], ['ó', 'ú'], ['ô', 'ụ'],
  ['­', 'ư'], ['õ', 'ừ'], ['ö', 'ử'], ['÷', 'ữ'], ['ø', 'ứ'], ['ù', 'ự'],
  // y
  ['ú', 'ỳ'], ['û', 'ỷ'], ['ü', 'ỹ'], ['ý', 'ý'], ['þ', 'ỵ'],
  // đ and the capitals the code page has
  ['®', 'đ'], ['¡', 'Ă'], ['¢', 'Â'], ['£', 'Ê'], ['¤', 'Ô'], ['¥', 'Ơ'], ['¦', 'Ư'], ['§', 'Đ'],
];

/** TCVN3 character (as read through code page 1252) -> Unicode letter. */
export const TCVN3 = Object.fromEntries(PAIRS);

// letters only Unicode Vietnamese has (a legacy font cannot hold them), and Latin-1 letters TCVN3 does not use
const UNICODE_VI = /[ĂăĐđƠơƯưẠ-ỹ]/;
const NOT_TCVN3 = /[À-ÅÍÙ-Ûàð]/;

/** Text in TCVN3 turned into Unicode (capitals: the font shows capitals, .VnTimeH). %% codes are kept. */
export function decodeTcvn3(s, capitals = false) {
  let out = '';
  const t = String(s ?? '');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '%' && t[i + 1] === '%' && i + 2 < t.length) {
      out += t.slice(i, i + 3);
      i += 2;
      continue;
    }
    const c = TCVN3[t[i]] ?? t[i];
    out += capitals ? c.toLocaleUpperCase('vi') : c;
  }
  return out;
}

/** Whether a text looks typed for a TCVN3 font: it has TCVN3 letters and nothing only Unicode or Latin-1 has. */
export function looksTcvn3(s) {
  const t = String(s ?? '');
  if (UNICODE_VI.test(t) || NOT_TCVN3.test(t)) return false;
  let n = 0;
  for (const ch of t) if (TCVN3[ch]) n++;
  return n > 0;
}

// VNI (VNI-Times, VNI-Helve...): a toned vowel is the base letter followed by a mark character ("MAËT BAÈNG" is
// "MẶT BẰNG"); ơ, ư, đ and the i letters are single characters.
const COMB = { circ: '̂', breve: '̆', horn: '̛', acute: '́', grave: '̀', hook: '̉', tilde: '̃', dot: '̣' };
const VNI_MARKS = {
  'ù': [null, 'acute'], 'ø': [null, 'grave'], 'û': [null, 'hook'], 'õ': [null, 'tilde'], 'ï': [null, 'dot'],
  'â': ['circ', null], 'á': ['circ', 'acute'], 'à': ['circ', 'grave'], 'å': ['circ', 'hook'], 'ã': ['circ', 'tilde'], 'ä': ['circ', 'dot'],
  'ê': ['breve', null], 'é': ['breve', 'acute'], 'è': ['breve', 'grave'], 'ú': ['breve', 'hook'], 'ü': ['breve', 'tilde'], 'ë': ['breve', 'dot'],
};
const VNI_SINGLE = {
  'ñ': 'đ', 'Ñ': 'Đ', 'ô': 'ơ', 'Ô': 'Ơ', 'ö': 'ư', 'Ö': 'Ư', 'æ': 'ỉ', 'Æ': 'Ỉ', 'ó': 'ĩ', 'Ó': 'Ĩ', 'ò': 'ị', 'Ò': 'Ị', 'î': 'ỵ', 'Î': 'Ỵ',
};

/** VNI sequence (one or two characters, as read through code page 1252) -> Unicode letter. */
export const VNI = (() => {
  const m = { ...VNI_SINGLE };
  const bases = { a: ['a', ''], e: ['e', ''], o: ['o', ''], u: ['u', ''], y: ['y', ''], 'ô': ['o', COMB.horn], 'ö': ['u', COMB.horn] };
  for (const [b, [letter, horn]] of Object.entries(bases)) {
    for (const [mk, [shape, tone]] of Object.entries(VNI_MARKS)) {
      if (shape === 'circ' && !'aeo'.includes(b)) continue;
      if (shape === 'breve' && b !== 'a') continue;
      if (horn && shape) continue;
      const lower = (letter + horn + (shape ? COMB[shape] : '') + (tone ? COMB[tone] : '')).normalize('NFC');
      const upper = lower.toLocaleUpperCase('vi');
      for (const base of [b, b.toLocaleUpperCase('vi')]) {
        for (const mark of [mk, mk.toLocaleUpperCase('vi')]) m[base + mark] = base === b ? lower : upper;
      }
    }
  }
  return m;
})();

/** Text in VNI turned into Unicode: two-character sequences first. */
export function decodeVni(s) {
  const t = String(s ?? '');
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const two = t.slice(i, i + 2);
    if (two.length === 2 && VNI[two]) {
      out += VNI[two];
      i++;
    } else out += VNI[t[i]] ?? t[i];
  }
  return out;
}

const VOWEL = /[aeiouyAEIOUYôöÔÖ]/;
// Latin-1 letters Unicode Vietnamese has (PHÒNG, LÊN, CÔNG): typed in Unicode they prove nothing; the other characters
// a legacy encoding uses are not Vietnamese letters, so they show the text was typed for a legacy font
const VI_LATIN1 = new Set([...'ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúý']);

/** The legacy encoding a text seems typed in: 'tcvn3', 'vni' or null (Unicode or plain). */
export function legacyEncoding(s) {
  const t = String(s ?? '');
  if (UNICODE_VI.test(t) || /[\u3400-\u9FFF\uF900-\uFAFF]/.test(t)) return null;
  let vni = 0, tcvn = 0, vniStrong = 0, tcvnStrong = 0;
  const letter = (ch) => !!ch && (/[A-Za-z]/.test(ch) || !!TCVN3[ch]);
  for (let i = 0; i < t.length; i++) {
    const c = t[i], prev = t[i - 1] ?? ' ';
    if (VNI[prev + c] && VNI_MARKS[c.toLocaleLowerCase('vi')]) {
      vni++;
      if (!VI_LATIN1.has(c)) vniStrong++;
    } else if (VNI_SINGLE[c] && !VI_LATIN1.has(c) && !TCVN3[c]) {
      vni++;
      vniStrong++;
    } else if (TCVN3[c] && !VOWEL.test(prev)) {
      tcvn++;
      if (!VI_LATIN1.has(c) && (letter(t[i - 1]) || letter(t[i + 1]))) tcvnStrong++;
    }
  }
  if (vni > tcvn && (vniStrong > 0 || vni >= 3)) return 'vni';
  return tcvnStrong > 0 && !NOT_TCVN3.test(t) ? 'tcvn3' : null;
}

/** How many VNI letter pairs (a vowel and its mark, "AÀ") a text has: weak alone, telling across a style's texts. */
export function vniPairs(s) {
  const t = String(s ?? '');
  if (UNICODE_VI.test(t)) return 0;
  let n = 0;
  for (let i = 1; i < t.length; i++) if (VNI[t[i - 1] + t[i]] && VNI_MARKS[t[i].toLocaleLowerCase('vi')]) n++;
  return n;
}

/** A text in a legacy encoding turned into Unicode (the encoding found by legacyEncoding unless given). */
export function decodeLegacy(s, encoding = legacyEncoding(s)) {
  return encoding === 'vni' ? decodeVni(s) : encoding === 'tcvn3' ? decodeTcvn3(s) : String(s ?? '');
}
