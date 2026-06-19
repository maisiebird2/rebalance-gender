import XLSX from "xlsx";
const wb = XLSX.readFile("../women, femmes, enbies of electronic music.xlsx");
const ws = wb.Sheets["list"];
const ref = XLSX.utils.decode_range(ws["!ref"]);
let count = 0;
for (let r = ref.s.r + 1; r <= ref.e.r; r++) {
  const nameCell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
  const bpCell = ws[XLSX.utils.encode_cell({ r, c: 9 })];
  if (bpCell && bpCell.v) {
    count++;
    console.log(JSON.stringify(nameCell?.v), JSON.stringify(bpCell.v), bpCell.l?.Target);
  }
}
console.log("total", count);
