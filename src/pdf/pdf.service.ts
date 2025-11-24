import { Injectable, Logger } from '@nestjs/common';
import * as puppeteer from 'puppeteer';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

export interface PdfOptions {
  format?: 'A4' | 'Letter';
  printBackground?: boolean;
  margin?: {
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
  };
}

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);

  /**
   * Generate PDF from HTML string
   */
  async generateFromHtml(html: string, options: PdfOptions = {}): Promise<Buffer> {
    let browser;
    let userDataDir: string | null = null;
    try {
      this.logger.log('Launching Puppeteer browser...');
      
      // Use a temporary user data directory to avoid conflicts with other Chrome instances
      userDataDir = path.join(os.tmpdir(), `puppeteer-${Date.now()}-${Math.random().toString(36).substring(7)}`);
      
      // Minimal configuration - just what's needed
      browser = await puppeteer.launch({
        headless: true,
        userDataDir: userDataDir, // Separate directory to avoid conflicts
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      });

      const page = await browser.newPage();
      
      // Set content
      await page.setContent(html, {
        waitUntil: 'load',
      });

      // Generate PDF
      const pdfBuffer = await page.pdf({
        format: options.format || 'A4',
        printBackground: options.printBackground !== false,
        margin: options.margin || {
          top: '20mm',
          right: '15mm',
          bottom: '20mm',
          left: '15mm',
        },
      });

      this.logger.log(`PDF generated successfully (${pdfBuffer.length} bytes)`);
      
      return Buffer.from(pdfBuffer);
    } catch (error: any) {
      this.logger.error('Error generating PDF:', error);
      throw new Error(`Failed to generate PDF: ${error.message}`);
    } finally {
      if (browser) {
        try {
          const pages = await browser.pages();
          for (const page of pages) {
            await page.close().catch(() => {});
          }
          await browser.close();
          this.logger.log('Browser closed');
        } catch (closeError) {
          this.logger.warn('Error closing browser:', closeError);
        }
      }
      
      // Clean up user data directory
      if (userDataDir) {
        try {
          if (fs.existsSync(userDataDir)) {
            fs.rmSync(userDataDir, { recursive: true, force: true });
          }
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Generate PDF from LaTeX code
   * Requires pdflatex to be installed on the system
   * For Windows: Install MiKTeX or TeX Live
   * For Linux/Mac: Install texlive or similar
   */
  async generateFromLatex(latexCode: string, options: PdfOptions = {}): Promise<Buffer> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-'));
    const texFile = path.join(tempDir, 'document.tex');
    const pdfFile = path.join(tempDir, 'document.pdf');

    try {
      // Write LaTeX code to file
      fs.writeFileSync(texFile, latexCode, 'utf-8');
      this.logger.log(`LaTeX file written to: ${texFile}`);

      // Compile LaTeX to PDF using pdflatex
      // Run twice to ensure references are resolved
      const pdflatexCmd = process.platform === 'win32' 
        ? 'pdflatex.exe' 
        : 'pdflatex';

      try {
        // First compilation
        const { stdout: stdout1, stderr: stderr1 } = await execAsync(
          `${pdflatexCmd} -interaction=nonstopmode -output-directory="${tempDir}" "${texFile}"`,
          { timeout: 30000, cwd: tempDir }
        );

        // Log LaTeX output for debugging
        if (stdout1) {
          const stdoutPreview = stdout1.length > 500 ? stdout1.substring(0, 500) + '...' : stdout1;
          this.logger.debug(`LaTeX stdout (1st pass): ${stdoutPreview}`);
          
          // Check for errors in output
          if (stdout1.includes('!')) {
            const errorLines = stdout1.split('\n').filter(line => line.includes('!')).slice(0, 5);
            this.logger.error(`LaTeX errors detected:\n${errorLines.join('\n')}`);
          }
        }
        if (stderr1 && stderr1.trim()) {
          this.logger.debug(`LaTeX stderr (1st pass): ${stderr1.substring(0, 500)}`);
        }

        // Second compilation (for references, table of contents, etc.)
        const { stdout: stdout2, stderr: stderr2 } = await execAsync(
          `${pdflatexCmd} -interaction=nonstopmode -output-directory="${tempDir}" "${texFile}"`,
          { timeout: 30000, cwd: tempDir }
        );

        // Check for errors in second compilation
        if (stdout2) {
          if (stdout2.includes('!')) {
            const errorLines = stdout2.split('\n').filter(line => line.includes('!')).slice(0, 5);
            this.logger.error(`LaTeX errors detected (2nd pass):\n${errorLines.join('\n')}`);
            throw new Error('LaTeX compilation failed with errors. Check logs for details.');
          }
        }
        if (stderr2 && stderr2.trim() && !stderr2.includes('Warning')) {
          this.logger.warn(`LaTeX compilation warnings (2nd pass): ${stderr2.substring(0, 500)}`);
        }
      } catch (compileError: any) {
        // Log the full error details
        this.logger.error(`LaTeX compilation error: ${compileError.message}`);
        if (compileError.stdout) {
          const errorPreview = compileError.stdout.length > 1000 
            ? compileError.stdout.substring(0, 1000) + '...' 
            : compileError.stdout;
          this.logger.error(`LaTeX stdout: ${errorPreview}`);
          
          // Extract error lines
          const errorLines = compileError.stdout.split('\n')
            .filter((line: string) => line.includes('!') || line.includes('Error'))
            .slice(0, 10);
          if (errorLines.length > 0) {
            this.logger.error(`LaTeX error details:\n${errorLines.join('\n')}`);
          }
        }
        if (compileError.stderr) {
          this.logger.error(`LaTeX stderr: ${compileError.stderr.substring(0, 500)}`);
        }
        
        // Check if pdflatex is not installed
        if (compileError.message?.includes('not found') || 
            compileError.message?.includes('is not recognized') ||
            compileError.code === 'ENOENT') {
          throw new Error(
            'pdflatex is not installed. Please install a LaTeX distribution:\n' +
            'Windows: Install MiKTeX (https://miktex.org/) or TeX Live\n' +
            'Linux: sudo apt-get install texlive-latex-base texlive-latex-extra\n' +
            'Mac: brew install --cask mactex'
          );
        }
        throw compileError;
      }

      // Check if PDF was generated
      if (!fs.existsSync(pdfFile)) {
        throw new Error('PDF file was not generated. Check LaTeX compilation errors.');
      }

      // Read PDF buffer
      const pdfBuffer = fs.readFileSync(pdfFile);
      this.logger.log(`PDF generated successfully from LaTeX (${pdfBuffer.length} bytes)`);

      return pdfBuffer;
    } catch (error: any) {
      this.logger.error('Error generating PDF from LaTeX:', error);
      throw new Error(`Failed to generate PDF from LaTeX: ${error.message}`);
    } finally {
      // Cleanup temp files
      try {
        if (fs.existsSync(tempDir)) {
          const files = fs.readdirSync(tempDir);
          files.forEach(file => {
            try {
              fs.unlinkSync(path.join(tempDir, file));
            } catch (unlinkError) {
              // Ignore cleanup errors
            }
          });
          fs.rmdirSync(tempDir);
        }
      } catch (cleanupError) {
        this.logger.warn('Failed to cleanup temp files:', cleanupError);
      }
    }
  }
}

