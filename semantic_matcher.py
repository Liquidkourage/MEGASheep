import json
from flask import Flask, request, jsonify
from flask_cors import CORS
from sentence_transformers import SentenceTransformer
import numpy as np
from typing import List, Dict, Tuple
import difflib

app = Flask(__name__)
CORS(app)

# Load Sentence Transformer model
try:
    model = SentenceTransformer('all-MiniLM-L6-v2')  # Fast and effective model
    print("[SUCCESS] Sentence Transformer model loaded successfully")
except Exception as e:
    print(f"[ERROR] Error loading Sentence Transformer model: {e}")
    exit(1)

# Synonym dictionary for common cases that semantic models might miss
SYNONYM_DICT = {
    'cock': ['rooster', 'chicken', 'hen'],
    'rooster': ['cock', 'chicken', 'hen'],
    'chicken': ['cock', 'rooster', 'hen'],
    'hen': ['cock', 'rooster', 'chicken'],
    'dragon': ['draggon', 'dragun', 'dragonn', 'drgon'],
    'draggon': ['dragon'],
    'dragun': ['dragon'],
    'dragonn': ['dragon'],
    'drgon': ['dragon'],
    'pig': ['piggy', 'hog', 'swine'],
    'piggy': ['pig', 'hog', 'swine'],
    'hog': ['pig', 'piggy', 'swine'],
    'swine': ['pig', 'piggy', 'hog'],
    'rat': ['mouse', 'rodent'],
    'mouse': ['rat', 'rodent'],
    'rodent': ['rat', 'mouse'],
    'ox': ['bull', 'cow', 'cattle'],
    'bull': ['ox', 'cow', 'cattle'],
    'cow': ['ox', 'bull', 'cattle'],
    'cattle': ['ox', 'bull', 'cow'],
    'tiger': ['cat', 'feline'],
    'cat': ['tiger', 'feline'],
    'feline': ['tiger', 'cat'],
    'rabbit': ['bunny', 'hare'],
    'bunny': ['rabbit', 'hare'],
    'hare': ['rabbit', 'bunny'],
    'snake': ['serpent', 'reptile'],
    'serpent': ['snake', 'reptile'],
    'reptile': ['snake', 'serpent'],
    'horse': ['steed', 'mare', 'stallion'],
    'steed': ['horse', 'mare', 'stallion'],
    'mare': ['horse', 'steed', 'stallion'],
    'stallion': ['horse', 'steed', 'mare'],
    'goat': ['billy', 'nanny'],
    'billy': ['goat', 'nanny'],
    'nanny': ['goat', 'billy'],
    'monkey': ['ape', 'primate'],
    'ape': ['monkey', 'primate'],
    'primate': ['monkey', 'ape'],
    'dog': ['canine', 'hound', 'puppy'],
    'canine': ['dog', 'hound', 'puppy'],
    'hound': ['dog', 'canine', 'puppy'],
    'puppy': ['dog', 'canine', 'hound']
}

def normalize(text: str) -> str:
    """Normalize text for comparison"""
    return text.lower().strip()

def compute_fuzzy_similarity(text1: str, text2: str) -> float:
    """Compute fuzzy string similarity using difflib"""
    return difflib.SequenceMatcher(None, normalize(text1), normalize(text2)).ratio()

def compute_semantic_similarity(text1: str, text2: str) -> float:
    """Compute semantic similarity between two texts using Sentence Transformers"""
    try:
        # Encode the texts
        embeddings = model.encode([normalize(text1), normalize(text2)])
        
        # Compute cosine similarity
        similarity = np.dot(embeddings[0], embeddings[1]) / (np.linalg.norm(embeddings[0]) * np.linalg.norm(embeddings[1]))
        return float(similarity)
    except Exception as e:
        print(f"Error computing semantic similarity between '{text1}' and '{text2}': {e}")
        return 0.0

def compute_hybrid_similarity(text1: str, text2: str) -> float:
    """Compute hybrid similarity combining fuzzy and semantic matching"""
    # Check synonym dictionary first
    normalized1 = normalize(text1)
    normalized2 = normalize(text2)
    
    # If exact match in synonym dictionary, return high confidence
    if normalized1 in SYNONYM_DICT and normalized2 in SYNONYM_DICT[normalized1]:
        return 0.95  # 95% confidence for known synonyms
    
    # Also check reverse direction
    if normalized2 in SYNONYM_DICT and normalized1 in SYNONYM_DICT[normalized2]:
        return 0.95  # 95% confidence for known synonyms
    
    # Fall back to hybrid algorithm
    fuzzy_sim = compute_fuzzy_similarity(text1, text2)
    semantic_sim = compute_semantic_similarity(text1, text2)
    
    # For short words (likely typos), give more weight to fuzzy matching
    # For longer phrases, give more weight to semantic matching
    avg_length = (len(text1) + len(text2)) / 2
    
    if avg_length <= 10:  # Short words - likely typos
        # Weight fuzzy matching more heavily for short words
        hybrid_sim = (fuzzy_sim * 0.7) + (semantic_sim * 0.3)
    else:  # Longer phrases - use semantic matching more
        hybrid_sim = (fuzzy_sim * 0.3) + (semantic_sim * 0.7)
    
    return hybrid_sim

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
            
            # Find the best matching correct answer using hybrid similarity
            for correct_answer in correct_answers:
                similarity = compute_hybrid_similarity(response, correct_answer)
                if similarity > best_similarity:
                    best_similarity = similarity
                    best_match = correct_answer
            
            confidence = compute_confidence(best_similarity)
            
            result = {
                'response': response,
                'best_match': best_match if best_match else None,
                'similarity': round(best_similarity, 2),
                'confidence': round(confidence, 2)
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
    print("[STARTING] Hybrid fuzzy + semantic matcher...")
    print("[SERVER] Available at http://127.0.0.1:5005")
    app.run(host='127.0.0.1', port=5005, debug=True) 