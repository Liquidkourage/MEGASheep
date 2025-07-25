import json
from flask import Flask, request, jsonify
from flask_cors import CORS
import spacy
import numpy as np
from typing import List, Dict, Tuple

app = Flask(__name__)
CORS(app)

# Load spaCy model with word vectors
try:
    nlp = spacy.load("en_core_web_md")
    print("✅ spaCy model loaded successfully")
except OSError:
    print("❌ Error: en_core_web_md model not found. Please run: python -m spacy download en_core_web_md")
    exit(1)

def normalize(text: str) -> str:
    """Normalize text for comparison"""
    return text.lower().strip()

# Chinese zodiac synonyms mapping
CHINESE_ZODIAC_SYNONYMS = {
    'rat': ['mouse', 'rodent'],
    'ox': ['bull', 'cow', 'cattle'],
    'tiger': ['big cat', 'feline'],
    'rabbit': ['bunny', 'hare'],
    'dragon': ['dragon'],
    'snake': ['serpent'],
    'horse': ['steed', 'mare', 'stallion'],
    'goat': ['sheep', 'ram', 'ewe'],
    'monkey': ['ape', 'primate'],
    'rooster': ['chicken', 'hen', 'cock'],
    'dog': ['canine', 'hound'],
    'pig': ['hog', 'swine', 'boar']
}

def get_zodiac_synonym_boost(text1: str, text2: str) -> float:
    """Check if two texts are Chinese zodiac synonyms and return a boost"""
    text1_lower = normalize(text1)
    text2_lower = normalize(text2)
    
    # Check if either text is a correct answer
    for correct_answer, synonyms in CHINESE_ZODIAC_SYNONYMS.items():
        if text1_lower == correct_answer:
            if text2_lower in synonyms:
                return 0.8  # High boost for direct synonyms
        elif text2_lower == correct_answer:
            if text1_lower in synonyms:
                return 0.8  # High boost for direct synonyms
    
    # Check if both are synonyms of the same animal
    for correct_answer, synonyms in CHINESE_ZODIAC_SYNONYMS.items():
        if text1_lower in synonyms and text2_lower in synonyms:
            return 0.6  # Medium boost for synonym-to-synonym
    
    return 0.0

def compute_similarity(text1: str, text2: str) -> float:
    """Compute semantic similarity between two texts using spaCy embeddings with Chinese zodiac enhancement"""
    try:
        # Process the texts
        doc1 = nlp(normalize(text1))
        doc2 = nlp(normalize(text2))
        
        # If either document has no vector, return 0
        if not doc1.has_vector or not doc2.has_vector:
            return 0.0
        
        # Compute base cosine similarity
        base_similarity = doc1.similarity(doc2)
        
        # Apply Chinese zodiac synonym boost
        zodiac_boost = get_zodiac_synonym_boost(text1, text2)
        
        # Combine base similarity with zodiac boost
        enhanced_similarity = min(1.0, base_similarity + zodiac_boost)
        
        return float(enhanced_similarity)
    except Exception as e:
        print(f"Error computing similarity between '{text1}' and '{text2}': {e}")
        return 0.0

def compute_confidence(similarity: float) -> float:
    """Convert similarity score to confidence percentage"""
    # Map similarity (0-1) to confidence (0-100)
    # Higher similarity = higher confidence
    return min(100.0, max(0.0, similarity * 100))

@app.route('/semantic-match', methods=['POST'])
def semantic_match():
    """Find semantic matches between responses and correct answers"""
    try:
        data = request.get_json()
        question = data.get('question', '')
        correct_answers = data.get('correct_answers', [])
        responses = data.get('responses', [])
        
        print(f"Processing question: {question}")
        print(f"Correct answers: {correct_answers}")
        print(f"Responses: {responses}")
        
        results = []
        
        for response in responses:
            best_match = None
            best_similarity = 0.0
            
            # Find the best matching correct answer
            for correct_answer in correct_answers:
                similarity = compute_similarity(response, correct_answer)
                if similarity > best_similarity:
                    best_similarity = similarity
                    best_match = correct_answer
            
            confidence = compute_confidence(best_similarity)
            
            result = {
                'response': response,
                'best_match': best_match if best_match else None,
                'similarity': best_similarity,
                'confidence': confidence
            }
            
            results.append(result)
            print(f"'{response}' -> '{best_match}' (confidence: {confidence:.1f}%)")
        
        return jsonify({
            'success': True,
            'results': results
        })
        
    except Exception as e:
        print(f"Error in semantic_match: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

if __name__ == '__main__':
    print("🚀 Starting spaCy-based semantic matcher...")
    print("📡 Server will be available at http://127.0.0.1:5005")
    app.run(port=5005, debug=True) 