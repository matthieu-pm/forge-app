// ICU legacy identifiers, filtered by the same installed Intl implementation as
// the owning contracts. Calendar fixtures exercise their actual source behavior.
export const legacyIntlTimezones = 'ACT AET AGT ART AST BET BST CAT CNT CST CTT EAT ECT EST HST IET IST JST MIT MST NET NST PLT PNT PRT PST SST VST'.split(' ').filter(timeZone => {
  try { new Intl.DateTimeFormat('en', {timeZone}).format(); return true }
  catch { return false }
})
