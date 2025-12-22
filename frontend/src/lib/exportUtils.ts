import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';

export interface TableColumn {
  header: string;
  accessor: string | ((row: any) => string);
  align?: 'left' | 'center' | 'right';
}

export interface ExportOptions {
  title: string;
  filename: string;
  summary?: Array<{ label: string; value: string | number }>;
  columns: TableColumn[];
  data: any[];
  dateRange?: { start: string; end: string };
}

// Export to PDF
export function exportToPDF(options: ExportOptions) {
  const { title, filename, summary, columns, data, dateRange } = options;
  const doc = new jsPDF();

  // Add title
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(title, 14, 20);

  // Add date range if provided
  let yPos = 30;
  if (dateRange) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`Period: ${dateRange.start} to ${dateRange.end}`, 14, yPos);
    yPos += 10;
  }

  // Add summary if provided
  if (summary && summary.length > 0) {
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('Summary', 14, yPos);
    yPos += 8;

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    summary.forEach((item) => {
      doc.text(`${item.label}: ${item.value}`, 14, yPos);
      yPos += 6;
    });
    yPos += 4;
  }

  // Prepare table data
  const headers = columns.map((col) => col.header);
  const rows = data.map((row) =>
    columns.map((col) => {
      if (typeof col.accessor === 'function') {
        return col.accessor(row);
      }
      return row[col.accessor] || '';
    })
  );

  // Add table
  autoTable(doc, {
    head: [headers],
    body: rows,
    startY: yPos,
    styles: { fontSize: 9 },
    headStyles: { fillColor: [66, 139, 202] },
    columnStyles: columns.reduce((acc, col, index) => {
      if (col.align) {
        acc[index] = { halign: col.align };
      }
      return acc;
    }, {} as any),
  });

  // Add footer
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.text(
      `Page ${i} of ${pageCount}`,
      doc.internal.pageSize.getWidth() / 2,
      doc.internal.pageSize.getHeight() - 10,
      { align: 'center' }
    );
    doc.text(
      `Generated on ${new Date().toLocaleString()}`,
      14,
      doc.internal.pageSize.getHeight() - 10
    );
  }

  doc.save(`${filename}.pdf`);
}

// Export to Excel
export function exportToExcel(options: ExportOptions) {
  const { title, filename, summary, columns, data, dateRange } = options;

  const workbook = XLSX.utils.book_new();
  const worksheetData: any[][] = [];

  // Add title
  worksheetData.push([title]);
  worksheetData.push([]);

  // Add date range if provided
  if (dateRange) {
    worksheetData.push([`Period: ${dateRange.start} to ${dateRange.end}`]);
    worksheetData.push([]);
  }

  // Add summary if provided
  if (summary && summary.length > 0) {
    worksheetData.push(['Summary']);
    summary.forEach((item) => {
      worksheetData.push([item.label, item.value]);
    });
    worksheetData.push([]);
  }

  // Add table headers
  const headers = columns.map((col) => col.header);
  worksheetData.push(headers);

  // Add table data
  data.forEach((row) => {
    const rowData = columns.map((col) => {
      if (typeof col.accessor === 'function') {
        return col.accessor(row);
      }
      return row[col.accessor] || '';
    });
    worksheetData.push(rowData);
  });

  const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);

  // Set column widths
  worksheet['!cols'] = columns.map(() => ({ wch: 20 }));

  XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');
  XLSX.writeFile(workbook, `${filename}.xlsx`);
}

// Export to CSV
export function exportToCSV(options: ExportOptions) {
  const { filename, columns, data } = options;

  const headers = columns.map((col) => col.header);
  const rows = data.map((row) =>
    columns.map((col) => {
      if (typeof col.accessor === 'function') {
        const value = col.accessor(row);
        // Escape commas and quotes in CSV
        return `"${String(value).replace(/"/g, '""')}"`;
      }
      const value = row[col.accessor] || '';
      return `"${String(value).replace(/"/g, '""')}"`;
    })
  );

  const csvContent = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);

  link.setAttribute('href', url);
  link.setAttribute('download', `${filename}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Print function
export function printReport() {
  window.print();
}
