// ─────────────────────────────────────────────
// services/resume-parser.service.ts
// Extracts text from uploaded PDF resumes using
// PDF.js loaded via CDN in index.html.
// Also runs basic keyword extraction for skills.
// ─────────────────────────────────────────────

import { Injectable } from "@angular/core";
import { ResumeData } from "../models/interview.models";

@Injectable({ providedIn: "root" })
export class ResumeParserService {
  // Common tech skills to detect in resume text
  private readonly SKILL_KEYWORDS = [
    "JavaScript",
    "TypeScript",
    "Python",
    "Java",
    "C#",
    "C++",
    "Go",
    "Rust",
    "Ruby",
    "PHP",
    "Angular",
    "React",
    "Vue",
    "Svelte",
    "Next.js",
    "Nuxt",
    "Node.js",
    "Express",
    "FastAPI",
    "Django",
    "Spring",
    "Laravel",
    "AWS",
    "Azure",
    "GCP",
    "Docker",
    "Kubernetes",
    "Terraform",
    "PostgreSQL",
    "MySQL",
    "MongoDB",
    "Redis",
    "Elasticsearch",
    "GraphQL",
    "REST",
    "gRPC",
    "Kafka",
    "RabbitMQ",
    "Git",
    "CI/CD",
    "Agile",
    "Scrum",
    "TDD",
    "Machine Learning",
    "AI",
    "HTML",
    "CSS",
    "SCSS",
    "Tailwind",
    "SQL",
  ];

  /**
   * Main entry point: accepts a File object and returns parsed ResumeData.
   * Supports PDF (via PDF.js) and plain text files.
   */
  async parseFile(file: File): Promise<ResumeData> {
    let rawText = "";

    if (file.type === "application/pdf") {
      rawText = await this.extractPdfText(file);
    } else if (file.type === "text/plain") {
      rawText = await this.readTextFile(file);
    } else {
      throw new Error(
        "Unsupported file type. Please upload a PDF or .txt file.",
      );
    }

    if (!rawText.trim()) {
      throw new Error(
        "Could not extract text from file. It may be a scanned image.",
      );
    }

    return {
      fileName: file.name,
      rawText: rawText.trim(),
      skills: this.extractSkills(rawText),
      experience: this.extractExperience(rawText),
      uploadedAt: new Date(),
    };
  }

  // ── PDF Extraction ────────────────────────────

  /**
   * Uses PDF.js (loaded via CDN) to extract text from each page.
   * Returns all page text concatenated.
   */
  private async extractPdfText(file: File): Promise<string> {
    // Access PDF.js from global scope (loaded via CDN in index.html)
    const pdfjsLib =
      (window as any)["pdfjsLib"] || (window as any)["pdfjs-dist/build/pdf"];

    if (!pdfjsLib) {
      // Fallback: read as binary text (less accurate but works)
      console.warn("PDF.js not found, trying fallback text extraction");
      return this.fallbackPdfRead(file);
    }

    // Set worker path for PDF.js
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let fullText = "";

    // Extract text from each page
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(" ");
      fullText += pageText + "\n";
    }

    return fullText;
  }

  /** Fallback: reads file as text (works for text-based PDFs sometimes) */
  private fallbackPdfRead(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        // Extract printable ASCII chars — rough but functional
        const extracted = text
          .replace(/[^\x20-\x7E\n]/g, " ")
          .replace(/\s{3,}/g, " ")
          .trim();
        resolve(extracted || "Could not parse PDF content.");
      };
      reader.onerror = () => reject(new Error("File read error"));
      reader.readAsBinaryString(file);
    });
  }

  // ── Text File Read ────────────────────────────

  private readTextFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = () => reject(new Error("Could not read file"));
      reader.readAsText(file);
    });
  }

  // ── Keyword Extraction ────────────────────────

  /** Scans resume text for known skill keywords (case-insensitive) */
  private extractSkills(text: string): string[] {
    return this.SKILL_KEYWORDS.filter((skill) => {
      const safeSkill = this.escapeRegex(skill);
      return new RegExp(`\\b${safeSkill}\\b`, "i").test(text);
    });
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Extracts job titles/experience lines using simple heuristics.
   * Looks for lines that contain common job-related words.
   */
  private extractExperience(text: string): string[] {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 10);
    const expKeywords =
      /engineer|developer|manager|lead|architect|analyst|designer|intern|senior|junior|staff/i;
    return lines.filter((l) => expKeywords.test(l)).slice(0, 5);
  }
}
