import json
from flask import Flask, request, jsonify
from flask_cors import CORS
from sentence_transformers import SentenceTransformer
import numpy as np
from typing import List, Dict, Tuple

app = Flask(__name__)
CORS(app)

# Load Sentence Transformer model
try:
    model = SentenceTransformer('all-MiniLM-L6-v2')  # Fast and effective model
    print("✅ Sentence Transformer model loaded successfully")
except Exception as e:
    print(f"❌ Error loading Sentence Transformer model: {e}")
    exit(1)

def normalize(text: str) -> str:
    """Normalize text for comparison"""
    return text.lower().strip()

def compute_similarity(text1: str, text2: str) -> float:
    """Compute semantic similarity between two texts using Sentence Transformers"""
    try:
        # Encode the texts
        embeddings = model.encode([normalize(text1), normalize(text2)])
        
        # Compute cosine similarity
        similarity = np.dot(embeddings[0], embeddings[1]) / (np.linalg.norm(embeddings[0]) * np.linalg.norm(embeddings[1]))
        return float(similarity)
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
    print("🚀 Starting Sentence Transformer-based semantic matcher...")
    print("📡 Server will be available at http://127.0.0.1:5005")
    app.run(port=5005, debug=True) 