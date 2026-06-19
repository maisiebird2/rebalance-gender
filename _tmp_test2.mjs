import XLSX from "xlsx";
const wb = XLSX.readFile("../women, femmes, enbies of electronic music.xlsx");
console.log("sheets:", wb.SheetNames);
const ws = wb.Sheets["duplicate names"];
console.log(XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(0, 10));
