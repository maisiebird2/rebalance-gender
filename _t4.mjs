import XLSX from "xlsx";
const wb = XLSX.readFile("women, femmes, enbies of electronic music.xlsx");
const ws = wb.Sheets["list"];
const range = XLSX.utils.decode_range(ws["!ref"]);
for (let r = range.s.r + 1; r <= range.e.r; r++) {
  const nameCell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
  const name = nameCell?.v?.toString();
  if (name && name.toUpperCase().includes("ROUGE".normalize()) ) {}
  if (name && /r.{0,2}ge/i.test(name) && name.length < 8) {
    console.log(JSON.stringify(name), [...name].map(c => c.codePointAt(0).toString(16)));
  }
}
