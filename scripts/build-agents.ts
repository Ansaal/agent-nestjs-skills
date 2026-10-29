#!/usr/bin/env npx ts-node

/**
 * Build script for generating compiled/<skill>.md for every skill with a rules/ directory
 *
 * Usage: npx ts-node scripts/build-agents.ts
 *
 * For each skills/<skill>/rules/ directory, this script:
 * 1. Reads the sections (prefix, name, impact) from rules/_sections.md
 * 2. Parses YAML frontmatter of every rule file
 * 3. Groups rules by section based on filename prefix
 * 4. Generates a consolidated compiled/<skill>.md file
 *
 * A rule without frontmatter or with an undeclared prefix fails the build.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Category {
  prefix: string;
  name: string;
  impact: string;
  section: number;
}

interface Skill {
  name: string;
  title: string;
  abstract: string;
  rulesDir: string;
}

interface RuleFrontmatter {
  title: string;
  impact: string;
  impactDescription: string;
  tags: string[];
}

interface Rule {
  filename: string;
  frontmatter: RuleFrontmatter;
  content: string;
  category: string;
  categorySection: number;
}

function parseFrontmatter(content: string): { frontmatter: RuleFrontmatter | null; body: string } {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: null, body: content };
  }

  const frontmatterStr = match[1];
  const body = match[2];

  // Simple YAML parsing for our expected format
  const frontmatter: Partial<RuleFrontmatter> = {};
  const lines = frontmatterStr.split('\n');
  let currentKey = '';
  let inArray = false;
  const arrayItems: string[] = [];

  for (const line of lines) {
    if (line.match(/^[a-zA-Z]+:/)) {
      // Save previous array if we were collecting one
      if (inArray && currentKey === 'tags') {
        frontmatter.tags = arrayItems;
      }
      inArray = false;
      arrayItems.length = 0;

      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':').trim();
      currentKey = key.trim();

      if (value === '') {
        // Might be start of array
        inArray = true;
      } else {
        (frontmatter as any)[currentKey] = value;
      }
    } else if (inArray && line.trim().startsWith('-')) {
      arrayItems.push(line.trim().replace(/^-\s*/, ''));
    }
  }

  // Save final array if needed
  if (inArray && currentKey === 'tags') {
    frontmatter.tags = arrayItems;
  }

  return {
    frontmatter: frontmatter as RuleFrontmatter,
    body: body.trim()
  };
}

/** Sections are declared in rules/_sections.md as `## <n>. <Name> (<prefix>)` followed by `**Impact:** <level>`. */
function readCategories(rulesDir: string): Category[] {
  const content = fs.readFileSync(path.join(rulesDir, '_sections.md'), 'utf-8');
  const sectionRegex = /^## (\d+)\. (.+?) \(([a-z0-9]+)\)\s*\n+\*\*Impact:\*\* (.+)$/gm;
  const categories: Category[] = [];
  for (const match of content.matchAll(sectionRegex)) {
    categories.push({
      section: Number(match[1]),
      name: match[2],
      prefix: `${match[3]}-`,
      impact: match[4].trim(),
    });
  }
  if (categories.length === 0) {
    throw new Error(`No sections found in ${path.join(rulesDir, '_sections.md')}`);
  }
  return categories.sort((a, b) => a.section - b.section);
}

interface Metadata {
  version: string;
  organization: string;
  date: string;
  references: string[];
}

function readMetadata(): Metadata {
  const metadataPath = path.join(__dirname, '..', 'metadata.json');
  // Repository-owned file, edited by maintainers alongside this script.
  return JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as Metadata;
}

function readSkills(): Skill[] {
  const skillsDir = path.join(__dirname, '..', 'skills');
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'rules')))
    .map((entry) => {
      const skillMd = fs.readFileSync(path.join(skillsDir, entry.name, 'SKILL.md'), 'utf-8');
      const title = skillMd.match(/^# (.+)$/m)?.[1];
      const abstract = skillMd.match(/^description: (.+)$/m)?.[1];
      if (!title || !abstract) {
        throw new Error(`skills/${entry.name}/SKILL.md needs a "# " title and a "description:" frontmatter line`);
      }
      return { name: entry.name, title, abstract, rulesDir: path.join(skillsDir, entry.name, 'rules') };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readRules(rulesDir: string, categories: Category[]): Rule[] {
  const files = fs.readdirSync(rulesDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('_'));

  const rules: Rule[] = [];

  for (const file of files) {
    const filePath = path.join(rulesDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter) {
      throw new Error(`No frontmatter found in ${filePath}`);
    }

    const category = categories.find((cat) => file.startsWith(cat.prefix));
    if (!category) {
      throw new Error(`Prefix of ${filePath} is not declared in _sections.md`);
    }

    rules.push({
      filename: file,
      frontmatter,
      content: body,
      category: category.name,
      categorySection: category.section
    });
  }

  return rules;
}

function generateTableOfContents(rulesByCategory: Map<string, Rule[]>, categories: Category[]): string {
  let toc = '## Table of Contents\n\n';

  for (const cat of categories) {
    const rules = rulesByCategory.get(cat.name);
    if (!rules || rules.length === 0) continue;

    // Section anchor format: #1-architecture
    const sectionAnchor = `${cat.section}-${cat.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    toc += `${cat.section}. [${cat.name}](#${sectionAnchor}) — **${cat.impact}**\n`;

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      // Rule anchor format: #11-rule-title
      const ruleNum = `${cat.section}${i + 1}`;
      const anchor = `${ruleNum}-${rule.frontmatter.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      toc += `   - ${cat.section}.${i + 1} [${rule.frontmatter.title}](#${anchor})\n`;
    }
  }

  return toc;
}

function generateAgentsMd(skill: Skill, rules: Rule[], categories: Category[], metadata: Metadata): string {
  // Group rules by category
  const rulesByCategory = new Map<string, Rule[]>();

  for (const rule of rules) {
    if (!rulesByCategory.has(rule.category)) {
      rulesByCategory.set(rule.category, []);
    }
    rulesByCategory.get(rule.category)!.push(rule);
  }

  // Sort rules within each category alphabetically
  for (const [category, categoryRules] of rulesByCategory) {
    categoryRules.sort((a, b) => a.filename.localeCompare(b.filename));
  }

  // Build document
  let doc = `# ${skill.title}

**Version ${metadata.version}**
${metadata.organization}
${metadata.date}

> **Note:**
> This document is mainly for agents and LLMs to follow when maintaining,
> generating, or refactoring NestJS codebases. Humans may also find it
> useful, but guidance here is optimized for automation and consistency
> by AI-assisted workflows.

---

## Abstract

${skill.abstract}

---

`;

  // Add table of contents
  doc += generateTableOfContents(rulesByCategory, categories);
  doc += '\n---\n\n';

  // Add rules by category
  for (const cat of categories) {
    const categoryRules = rulesByCategory.get(cat.name);
    if (!categoryRules || categoryRules.length === 0) continue;

    doc += `## ${cat.section}. ${cat.name}\n\n`;
    doc += `**Section Impact: ${cat.impact}**\n\n`;

    for (let i = 0; i < categoryRules.length; i++) {
      const rule = categoryRules[i];
      const ruleNumber = `${cat.section}.${i + 1}`;

      // Add rule header with number (anchor will be auto-generated as #11-title)
      doc += `### ${ruleNumber} ${rule.frontmatter.title}\n\n`;
      doc += `**Impact: ${rule.frontmatter.impact}** — ${rule.frontmatter.impactDescription}\n\n`;

      // Add rule content (skip the first header since we already added it)
      let ruleContent = rule.content;
      // Remove the first h1 or h2 header if it matches the title
      ruleContent = ruleContent.replace(/^#{1,2}\s+.*\n+/, '');
      // Remove the impact line if present (we already added it)
      ruleContent = ruleContent.replace(/^\*\*Impact:.*\*\*.*\n+/, '');

      doc += ruleContent;
      doc += '\n\n---\n\n';
    }
  }

  // Add references footer
  doc += `## References

`;
  for (const ref of metadata.references) {
    doc += `- ${ref}\n`;
  }

  doc += `
---

*Generated by build-agents.ts on ${new Date().toISOString().split('T')[0]}*
`;

  return doc;
}

function main() {
  const metadata = readMetadata();
  console.log(`Version: ${metadata.version}\n`);

  for (const skill of readSkills()) {
    const categories = readCategories(skill.rulesDir);
    const rules = readRules(skill.rulesDir, categories);

    console.log(`${skill.name}: ${rules.length} rules`);
    for (const cat of categories) {
      const count = rules.filter((rule) => rule.category === cat.name).length;
      if (count > 0) {
        console.log(`  ${cat.name}: ${count}`);
      }
    }

    const compiled = generateAgentsMd(skill, rules, categories, metadata);
    const outputPath = path.join(__dirname, '..', 'compiled', `${skill.name}.md`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, compiled);
    console.log(`  → compiled/${skill.name}.md (${compiled.length} bytes)\n`);
  }
}

main();
