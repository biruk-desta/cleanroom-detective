'use client';
import { useState } from 'react';
import {
  Upload,
  FileSpreadsheet,
  ArrowRight,
  ShieldCheck,
  Coffee,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
export function Welcome({
  onChoose,
  onExample,
  onDrop,
}: {
  onChoose: () => void;
  onExample: () => void;
  onDrop: (file: File) => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <section className="welcome-wrap">
      <div className="welcome-intro">
        <p className="eyebrow">A little clarity for your data</p>
        <h1>
          Messy spreadsheet?
          <br />
          <span>Let’s tidy it up.</span>
        </h1>
        <p>
          Find the small things that are easy to miss.
          <br className="desktop-break" /> See each suggestion, then choose what
          to change.
        </p>
      </div>
      <div className="start-options">
        <section
          className={`upload-card ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) onDrop(f);
          }}
        >
          <div className="upload-symbol">
            <Upload size={28} />
          </div>
          <h2>Start with your file</h2>
          <p>
            Drop a CSV here, or choose one
            <br />
            from your computer.
          </p>
          <Button className="primary-large" onClick={onChoose}>
            <Upload size={18} /> Choose a CSV file
          </Button>
          <small>CSV files up to 1 MB · 5,000 rows</small>
          <div className="csv-tip">
            <FileSpreadsheet size={17} />
            <span>
              Using Excel or Google Sheets? Save or download your spreadsheet as
              a <b>.csv</b> file.
            </span>
          </div>
        </section>
        <section className="example-card">
          <div className="example-heading">
            <span className="icon-tile">
              <Coffee size={22} />
            </span>
            <span className="quiet-tag">No file? No problem.</span>
          </div>
          <h2>Take a little test drive</h2>
          <p>
            Try a café’s example sales sheet.
            <br />
            We’ve added a few things to spot.
          </p>
          <div className="mini-sheet">
            <div className="mini-sheet-title">
              <FileSpreadsheet size={15} />
              <span>cafe-sales.csv</span>
              <span>Example</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Coffee</TableCell>
                  <TableCell>2</TableCell>
                  <TableCell>6.00</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Tea</TableCell>
                  <TableCell>
                    <span className="example-missing">?</span>
                  </TableCell>
                  <TableCell>7.50</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Sandwich</TableCell>
                  <TableCell>2</TableCell>
                  <TableCell>16.00</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <Button
            variant="outline"
            className="example-button"
            onClick={onExample}
          >
            Try the example <ArrowRight size={18} />
          </Button>
          <small>A made-up dataset for exploring the app.</small>
        </section>
      </div>
      <div className="welcome-promises">
        <span>
          <ShieldCheck /> Your original stays unchanged
        </span>
        <span>
          <Check /> You approve every edit
        </span>
        <span>
          <ArrowRight /> Download when you’re ready
        </span>
      </div>
    </section>
  );
}
