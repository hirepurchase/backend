import { FileText, FileSpreadsheet, File, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { exportToPDF, exportToExcel, exportToCSV, printReport, ExportOptions } from '@/lib/exportUtils';

interface ExportButtonsProps {
  exportOptions: ExportOptions;
  showPrint?: boolean;
}

export function ExportButtons({ exportOptions, showPrint = true }: ExportButtonsProps) {
  return (
    <div className="flex gap-2">
      {showPrint && (
        <Button variant="outline" size="sm" onClick={printReport}>
          <Printer className="h-4 w-4 mr-2" />
          Print
        </Button>
      )}

      <Button variant="outline" size="sm" onClick={() => exportToPDF(exportOptions)}>
        <FileText className="h-4 w-4 mr-2" />
        PDF
      </Button>

      <Button variant="outline" size="sm" onClick={() => exportToExcel(exportOptions)}>
        <FileSpreadsheet className="h-4 w-4 mr-2" />
        Excel
      </Button>

      <Button variant="outline" size="sm" onClick={() => exportToCSV(exportOptions)}>
        <File className="h-4 w-4 mr-2" />
        CSV
      </Button>
    </div>
  );
}
