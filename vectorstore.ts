// src/managers/search/vectorstore.ts
export class VectorStore {
  private static instance: VectorStore | null = null;
  private documents: Array<{
    id: string;
    content: string;
    metadata: { url: string, title: string };
    embedding: number[];
  }> = [];
  private initialized = false;
  private stopWords = new Set([
    'the', 'and', 'or', 'of', 'to', 'a', 'in', 'that', 'it', 'is', 'was', 'for', 
    'on', 'with', 'as', 'be', 'at', 'this', 'but', 'by', 'from', 'an', 'not', 
    'what', 'all', 'are', 'were', 'when', 'we', 'you', 'they', 'have', 'had'
  ]);

  private constructor() {}

  public static getInstance(): VectorStore {
    if (!VectorStore.instance) {
      VectorStore.instance = new VectorStore();
    }
    return VectorStore.instance;
  }

  public async initialize(): Promise<boolean> {
    try {
      // console.log("[VectorStore] Initializing simple in-memory vector store");
      this.documents = [];
      this.initialized = true;
      return true;
    } catch (error) {
      console.error("[VectorStore] Initialization failed:", error);
      return false;
    }
  }

  private cleanText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')  // Replace punctuation with spaces
      .replace(/\s+/g, ' ')      // Normalize whitespace
      .trim();
  }

  private createEmbedding(text: string): number[] {
    const cleanedText = this.cleanText(text);
    const words = cleanedText.split(/\s+/);
    const features: Record<string, number> = {};
    
    // Process unigrams (single words)
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (word.length > 2 && !this.stopWords.has(word)) {
        features[word] = (features[word] || 0) + 1;
      }
    }
    
    // Process bigrams (pairs of words)
    for (let i = 0; i < words.length - 1; i++) {
      const word1 = words[i];
      const word2 = words[i + 1];
      if (word1.length > 2 && word2.length > 2 && 
          !this.stopWords.has(word1) && !this.stopWords.has(word2)) {
        const bigram = `${word1}_${word2}`;
        features[bigram] = (features[bigram] || 0) + 0.8; // Lower weight for bigrams
      }
    }
    
    // Apply positional weighting
    const posWeightedFeatures = Object.fromEntries(
      Object.entries(features).map(([feature, count]) => {
        const firstPosition = words.findIndex(w => w === feature || feature.startsWith(w + '_'));
        if (firstPosition !== -1) {
          // Words earlier in text get higher weight (title/intro often contains key concepts)
          const posWeight = 1.0 - (Math.min(firstPosition, 100) / 100) * 0.5;
          return [feature, count * posWeight];
        }
        return [feature, count];
      })
    );
    
    // Get the top 384 most significant features
    const topFeatures = Object.entries(posWeightedFeatures)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 384)
      .map(entry => entry[0]);
    
    // Create the embedding vector
    const embedding = new Array(384).fill(0);
    const normalizer = words.length || 1;
    
    topFeatures.forEach((feature, index) => {
      embedding[index] = posWeightedFeatures[feature] / normalizer;
    });
    
    return embedding;
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < Math.min(vecA.length, vecB.length); i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    
    // Basic cosine similarity
    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    
    // Apply a penalty for very short chunks
    const nonZeroA = vecA.filter(v => v > 0).length;
    const nonZeroB = vecB.filter(v => v > 0).length;
    const lengthRatio = Math.min(nonZeroA, nonZeroB) / Math.max(nonZeroA, nonZeroB, 1);
    
    return similarity * (0.7 + 0.3 * lengthRatio);
  }

  public async addDocuments(documents: Array<{ url: string, title: string, content: string }>): Promise<boolean> {
    if (!this.initialized) {
      const success = await this.initialize();
      if (!success) return false;
    }
  
    try {
      // console.log(`[VectorStore] Processing ${documents.length} documents for embedding`);
      
      let totalChunks = 0;
      
      documents.forEach((doc, docIndex) => {
        // console.log(`[VectorStore] Processing document: ${doc.title.substring(0, 30)}...`);
        
        // Extract chunks using sentence boundaries where possible
        const sentences = doc.content.match(/[^.!?]+[.!?]+/g) || [];
        let chunks: string[] = [];
        
        if (sentences.length > 0) {
          // Group sentences into meaningful chunks
          let currentChunk = "";
          let currentLength = 0;
          
          sentences.forEach(sentence => {
            const trimmedSentence = sentence.trim();
            if (trimmedSentence.length < 10) return; // Skip very short sentences
            
            const sentenceLength = trimmedSentence.split(/\s+/).length;
            
            // If adding this sentence would make chunk too big, start a new chunk
            if (currentLength > 0 && currentLength + sentenceLength > 200) {
              if (currentChunk.length > 50) {
                chunks.push(currentChunk);
              }
              currentChunk = trimmedSentence;
              currentLength = sentenceLength;
            } else {
              // Add to current chunk
              currentChunk += (currentChunk ? " " : "") + trimmedSentence;
              currentLength += sentenceLength;
            }
          });
          
          // Add the last chunk if it exists
          if (currentChunk.length > 50) {
            chunks.push(currentChunk);
          }
        } else {
          // Fallback to paragraph splitting if sentence splitting fails
          chunks = doc.content.split(/\n{2,}/)
            .map(p => p.trim())
            .filter(p => p.length > 50);
          
          // If still no good chunks, use word-based chunking
          if (chunks.length <= 1 && doc.content.length > 500) {
            chunks = [];
            const words = doc.content.split(/\s+/);
            for (let i = 0; i < words.length; i += 200) {
              const chunk = words.slice(i, i + 200).join(' ');
              if (chunk.length > 50) {
                chunks.push(chunk);
              }
            }
          }
        }
        
        let chunkCount = 0;
        
        // Add title information to the first chunk for better relevance
        if (chunks.length > 0 && doc.title) {
          chunks[0] = `${doc.title}. ${chunks[0]}`;
        }
        
        chunks.forEach((chunk, chunkIndex) => {
          const embedding = this.createEmbedding(chunk);
          
          this.documents.push({
            id: `doc${docIndex}_chunk${chunkIndex}`,
            content: chunk,
            metadata: { url: doc.url, title: doc.title },
            embedding
          });
          
          chunkCount++;
          totalChunks++;
        });
        
        // console.log(`[VectorStore] Created ${chunkCount} chunks from document ${docIndex + 1}`);
      });
  
      // console.log(`[VectorStore] Added ${totalChunks} total chunks to in-memory store`);
      return true;
    } catch (error) {
      console.error("[VectorStore] Error adding documents:", error);
      return false;
    }
  }

  public async queryRelevantContent(queryText: string, limit = 5): Promise<Array<{
    content: string;
    metadata: { url: string, title: string };
    score: number;
  }>> {
    if (!this.initialized) {
      const success = await this.initialize();
      if (!success) return [];
    }
  
    try {
      // console.log(`[VectorStore] Querying with text: "${queryText.substring(0, 50)}..."`);
      
      if (this.documents.length === 0) {
        // console.log("[VectorStore] No documents in store to query");
        return [];
      }
      
      // Create embedding for query
      const queryEmbedding = this.createEmbedding(queryText);
      
      // Find similarities
      const similarities = this.documents.map(doc => ({
        content: doc.content,
        metadata: doc.metadata,
        score: this.cosineSimilarity(queryEmbedding, doc.embedding)
      }));
      
      // Sort by similarity (higher is better)
      const sorted = similarities.sort((a, b) => b.score - a.score);
      
      // Only consider chunks with similarity above a certain threshold
      const SIMILARITY_THRESHOLD = 0.275;
      const filteredResults = sorted.filter(item => item.score > SIMILARITY_THRESHOLD);
      
      // Prevent duplicate content from the same URL
      const uniqueResults: Array<{
        content: string;
        metadata: { url: string, title: string };
        score: number;
      }> = [];
      
      const seenUrls = new Set<string>();
      
      filteredResults.forEach(result => {
        // For each URL, only take the highest scoring chunk
        if (!seenUrls.has(result.metadata.url)) {
          uniqueResults.push(result);
          seenUrls.add(result.metadata.url);
        } else if (uniqueResults.length < limit) {
          // Allow additional chunks from same URL if we haven't reached the limit
          // but only if they're from different parts of the document (check content similarity)
          const existingChunk = uniqueResults.find(r => r.metadata.url === result.metadata.url);
          if (existingChunk) {
            // Simple check: chunks are different enough if they share less than 50% of the content
            const contentOverlap = this.contentSimilarity(existingChunk.content, result.content);
            if (contentOverlap < 0.5) {
              uniqueResults.push(result);
            }
          }
        }
      });
      
      // Return top results (up to limit)
      const results = uniqueResults.slice(0, limit);
      
      // console.log(`[VectorStore] Returning ${results.length} relevant chunks`);
      return results;
    } catch (error) {
      console.error("[VectorStore] Error querying:", error);
      return [];
    }
  }

  // Helper to check content overlap between chunks
  private contentSimilarity(text1: string, text2: string): number {
    const words1 = new Set(this.cleanText(text1).split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(this.cleanText(text2).split(/\s+/).filter(w => w.length > 2));
    
    let commonWords = 0;
    words1.forEach(word => {
      if (words2.has(word)) commonWords++;
    });
    
    const totalUniqueWords = words1.size + words2.size - commonWords;
    return totalUniqueWords > 0 ? commonWords / totalUniqueWords : 0;
  }

  public async close(): Promise<void> {
    // console.log("[VectorStore] Closing in-memory vector store");
    this.documents = [];
    this.initialized = false;
  }
}
