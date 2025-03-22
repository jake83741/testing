import puppeteer from 'puppeteer';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { VectorStore } from './vectorstore';

interface ScrapedDocument {
  url: string;
  title: string;
  content: string;
  source?: string; // Add a source field to track where the document came from
}

export class ArchiveSearchService {
  
  private static userAgents = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/113.0 Firefox/113.0',
    'Mozilla/5.0 (iPad; CPU OS 15_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBDV/iPad8,11;FBMD/iPad;FBSN/iPadOS;FBSV/15.6.1;FBSS/2;FBID/tablet;FBLC/en_US;FBOP/5]',
    'Mozilla/5.0 (Linux; Android 12; motorola edge 20 pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36'
  ];

  private static getRandomUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  static async getTopArchiveUrls(query: string, limit = 3): Promise<string[]> {
    let browser = null;
    try {
      const encodedQuery = encodeURIComponent(query);
      const searchUrl = `https://cse.google.com/cse?oe=utf8&ie=utf8&source=uds&q=${encodedQuery}&lr=&safe=active&sort=&filter=0&gl=&cr=&as_sitesearch=&as_oq=&cx=3594dd8ac17f24837&start=0`;
      
      browser = await puppeteer.launch({
        headless: "new",
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
      });
      
      const page = await browser.newPage();
      await page.setUserAgent(ArchiveSearchService.getRandomUserAgent());
      
      await page.goto(searchUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      
      await page.waitForTimeout(3000);
      
      const content = await page.content();
      
      const archiveRegex = /https?:\/\/archive\.(is|ph|today)\/[a-zA-Z0-9]{5,8}/g;
      const matches = content.match(archiveRegex) || [];
      
      const validMatches = matches.filter((url: string) => 
        !url.includes('search') && 
        !url.includes('/http')
      );
      
      // Filter for unique URLs only
      const uniqueUrls = Array.from(new Set(validMatches));
      
      return uniqueUrls.slice(0, limit);
    } catch (error) {
      console.error('Error in archive search:', error);
      return [];
    } finally {
      if (browser) {
        await browser.close().catch((err: any) => console.error('Error closing browser:', err));
      }
    }
  }
  
  static async scrapeContent(url: string): Promise<ScrapedDocument | null> {
    try {
      const { data } = await axios.get(url);
      const dom = new JSDOM(data);
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      
      if (article) {
        // Clean up the content
        let cleanContent = article.textContent || '';
        
        // Remove common cruft patterns
        cleanContent = cleanContent
          .replace(/For customer support contact.*?com\./gs, '')
          .replace(/READ COMMENTS.*?DISCUSSION/g, '')
          .replace(/Stories Chosen For You/g, '')
          .replace(/ADVERTISEMENT/gi, '')
          .replace(/\n{3,}/g, '\n\n')  // Normalize excessive newlines
          .replace(/\s{2,}/g, ' ')     // Normalize multiple spaces
          .trim();
        
        return {
          url,
          title: article.title || 'Unknown Title',
          content: cleanContent,
          source: 'archive' // Mark this as from archive
        };
      }
      return null;
    } catch (error) {
      console.error(`Error scraping URL ${url}:`, error);
      return null;
    }
  }

  // New method to scrape DuckDuckGo Lite search results
  static async getDuckDuckGoResults(query: string, limit = 8): Promise<ScrapedDocument[]> {
    let browser = null;
    try {
      // console.log(`[ArchiveSearchService] Scraping DuckDuckGo Lite for: ${query}`);
      const encodedQuery = encodeURIComponent(query);
      const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`;
      
      browser = await puppeteer.launch({
        headless: "new",
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
      });
      
      const page = await browser.newPage();
      await page.setUserAgent(ArchiveSearchService.getRandomUserAgent());
      
      await page.goto(searchUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      
      // console.log('[ArchiveSearchService] DuckDuckGo page loaded, extracting results');
      
      // Extract search results based on the actual HTML structure
      const results = await page.evaluate(() => {
        const searchResults: Array<{title: string, url: string, description: string}> = [];
        
        // Look for the comment indicating web results
        const comments = Array.from(document.childNodes)
          .filter(node => node.nodeType === 8) // Comment nodes
          .map(node => node.textContent);
        
        // console.log('Comments in page:', comments);
        
        // Find all result snippets
        const snippetCells = document.querySelectorAll('td.result-snippet');
        // console.log(`Found ${snippetCells.length} result snippet cells`);
        
        // For each snippet, find the corresponding title in the previous row
        snippetCells.forEach((cell) => {
          const row = cell.closest('tr');
          if (!row) return;
          
          // Title should be in the previous row
          const prevRow = row.previousElementSibling;
          if (!prevRow) return;
          
          // Find title cell and link
          const titleCell = prevRow.querySelector('td a');
          if (!titleCell) return;
          
          const title = titleCell.textContent?.trim() || '';
          const url = titleCell.getAttribute('href') || '';
          const description = cell.textContent?.trim() || '';
          
          if (title && url) {
            searchResults.push({ title, url, description });
          }
        });
        
        // Alternative method if the above doesn't find results
        if (searchResults.length === 0) {
          // console.log('Using alternative method to find results');
          
          // Find all table rows
          const rows = document.querySelectorAll('tr');
          
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            
            // Check if this row has a link - it might be a title row
            const link = row.querySelector('a');
            if (link && link.getAttribute('href') && 
                !link.getAttribute('href')?.includes('duckduckgo.com')) {
              const title = link.textContent?.trim() || '';
              const url = link.getAttribute('href') || '';
              
              // Check next row for description
              if (i + 1 < rows.length) {
                const nextRow = rows[i + 1];
                const description = nextRow.textContent?.trim() || '';
                
                if (title && url) {
                  searchResults.push({ title, url, description });
                  i++; // Skip the description row
                }
              }
            }
          }
        }
        
        return searchResults;
      });
      
      // console.log(`[ArchiveSearchService] Found ${results.length} DuckDuckGo results`);
      
      // Log each result for debugging
      results.forEach((result: { title: any; url: string; }, index: number) => {
        // console.log(`[ArchiveSearchService] DDG Result ${index + 1}: ${result.title} (${result.url.substring(0, 50)}...)`);
      });
      
      // If still no results, try a simpler approach to just get the links
      if (results.length === 0) {
        // console.log('[ArchiveSearchService] No results found with standard methods, trying direct link extraction');
        
        const links = await page.evaluate(() => {
          const allLinks = Array.from(document.querySelectorAll('a[href]'))
            .filter(a => {
              const href = a.getAttribute('href');
              return href && href.startsWith('http') && !href.includes('duckduckgo.com');
            });
            
          return allLinks.map(link => ({
            title: link.textContent?.trim() || 'Search Result',
            url: link.getAttribute('href') || '',
            description: ''
          }));
        });
        
        // console.log(`[ArchiveSearchService] Found ${links.length} links through direct extraction`);
        
        // Convert to ScrapedDocument format and limit the number of results
        return links.slice(0, limit).map((link: { url: any; title: any; }) => ({
          url: link.url,
          title: `DuckDuckGo: ${link.title}`,
          content: `${link.title}`,
          source: 'duckduckgo'
        }));
      }
      
      // Convert to ScrapedDocument format and limit the number of results
      return results.slice(0, limit).map((result: { url: any; title: any; description: any; }) => ({
        url: result.url,
        title: `DuckDuckGo: ${result.title}`,
        content: `${result.title}\n\n${result.description}`,
        source: 'duckduckgo'
      }));
      
    } catch (error) {
      console.error('[ArchiveSearchService] Error in DuckDuckGo search:', error);
      return [];
    } finally {
      if (browser) {
        await browser.close().catch((err: any) => console.error('Error closing browser:', err));
      }
    }
  }

  static async getRelevantContentWithVectorSearch(query: string): Promise<string | null> {
    try {
      // Get top archive URLs - now returns unique URLs
      const urls = await ArchiveSearchService.getTopArchiveUrls(query, 3);
      
      // Get DuckDuckGo results in parallel
      const ddgResultsPromise = ArchiveSearchService.getDuckDuckGoResults(query, 8);
      
      // Scrape content from each URL
      const archiveDocuments: ScrapedDocument[] = [];
      for (const url of urls) {
        const doc = await ArchiveSearchService.scrapeContent(url);
        if (doc && doc.content.length > 50) {
          archiveDocuments.push(doc);
        }
      }
      
      // Add DuckDuckGo results
      const ddgResults = await ddgResultsPromise;
      
      // Combine all documents
      const allDocuments = [...archiveDocuments, ...ddgResults];
  
      if (allDocuments.length === 0) {
        return null;
      }
  
      // Calculate total characters from all sources
      const totalSourceCharacters = allDocuments.reduce((total, doc) => total + doc.content.length, 0);
  
      // Initialize vector store
      const vectorStore = VectorStore.getInstance();
      const initialized = await vectorStore.initialize();
      
      if (!initialized) {
        return null;
      }
      
      // Add scraped content to vector store
      const documentsAdded = await vectorStore.addDocuments(allDocuments);
      if (!documentsAdded) {
        await vectorStore.close();
        return null;
      }
      
      // Query vector store for relevant content
      const relevantChunks = await vectorStore.queryRelevantContent(query, 5);
      
      // Check if we have DuckDuckGo results in our output
      const ddgChunks = relevantChunks.filter(chunk => 
        ddgResults.some(r => r.url === chunk.metadata.url)
      );
      
      // If no DuckDuckGo results are in the top results, add the top 2 DuckDuckGo results
      let finalChunks = [...relevantChunks];
      if (ddgChunks.length === 0 && ddgResults.length > 0) {
        // Create chunks from top DuckDuckGo results
        const topDdgChunks = ddgResults.slice(0, 2).map(doc => ({
          content: doc.content,
          metadata: { 
            url: doc.url, 
            title: `DuckDuckGo: ${doc.title}`  // Mark title to identify it as DuckDuckGo
          },
          score: 0.5 // Assign a reasonable score
        }));
        finalChunks = [...relevantChunks.slice(0, 3), ...topDdgChunks];
      }
      
      // Clean up resources
      await vectorStore.close();
      
      if (finalChunks.length === 0) {
        return null;
      }
      
      // Group by document to avoid repetition
      const groupedByDoc = finalChunks.reduce((acc, chunk) => {
        // Use a prefix in the title to identify source instead of separate source field
        const isDuckDuckGo = chunk.metadata.title.startsWith('DuckDuckGo:') || 
                             ddgResults.some(r => r.url === chunk.metadata.url);
        
        const sourcePrefix = isDuckDuckGo ? 'DuckDuckGo|' : '';
        const key = `${chunk.metadata.url}|${sourcePrefix}${chunk.metadata.title}`;
        
        if (!acc[key]) {
          acc[key] = [];
        }
        
        // Process the chunk to ensure complete sentences
        const sentences = this.extractCompleteSentences(chunk.content);
        
        acc[key].push(sentences);
        return acc;
      }, {} as Record<string, string[]>);
      
      // Calculate the true content length (excluding formatting additions)
      const contentOnlyLength = Object.values(groupedByDoc).flat().join('').length;
      
      // Format each document's relevant content with simplified source numbering
      let formattedContext = "";
      let sourceCounter = 1;
      
      Object.entries(groupedByDoc).forEach(([key, contents]) => {
        const parts = key.split('|');
        const isDuckDuckGo = parts.length > 2 && parts[1] === 'DuckDuckGo';
        
        // Use simple source numbering
        formattedContext += `Source ${sourceCounter}: `;
        
        // Add simple source type indicator
        if (isDuckDuckGo) {
          formattedContext += `Search Result`;
        } else {
          formattedContext += `Article`;
        }
        
        formattedContext += ` `;
        
        // Join only the relevant chunks, now with complete sentences
        // Replace newlines with spaces
        formattedContext += contents.join(' ').replace(/\n+/g, ' ');
        
        formattedContext += ` ---`;
        
        sourceCounter++;
      });
      
      // Calculate the formatted context length
      const contextLength = formattedContext.length;
      
      // This is the only log we're keeping - now with the true content percentage
      console.log(`(Provided ${Math.round((contentOnlyLength / totalSourceCharacters) * 100)}% of search context to the model.)`);
      
      // If the context is too large, trim it at a sentence boundary
      const MAX_CONTEXT_LENGTH = 4000;
      if (contextLength > MAX_CONTEXT_LENGTH) {
        formattedContext = this.trimToSentenceBoundary(formattedContext, MAX_CONTEXT_LENGTH) + "...(truncated)";
      }
      
      return formattedContext.trim();
    } catch (error) {
      console.error('[ArchiveSearchService] Error in vector search:', error);
      return null;
    }
  }
  
  // Helper method to extract complete sentences
  private static extractCompleteSentences(text: string): string {
    // Find all complete sentences
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
    
    // If we didn't find complete sentences, return the original text
    if (sentences.length === 0) return text;
    
    // Return the first 5 complete sentences
    return sentences.slice(0, 5).join(' ').trim();
  }
  
  // Helper method to trim text at a sentence boundary
  private static trimToSentenceBoundary(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    
    // Find the last sentence boundary before maxLength
    const lastBoundary = Math.max(
      text.lastIndexOf('.', maxLength),
      text.lastIndexOf('!', maxLength),
      text.lastIndexOf('?', maxLength)
    );
    
    // If we found a valid boundary, use it; otherwise just cut at maxLength
    return lastBoundary > 0 ? text.substring(0, lastBoundary + 1) : text.substring(0, maxLength);
  }
}
