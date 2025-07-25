import json
from flask import Flask, request, jsonify
from nltk.corpus import wordnet as wn
from nltk import download
from nltk.tokenize import word_tokenize
from collections import defaultdict
import string

# Ensure required NLTK data is downloaded
try:
    wn.synsets('dog')
except LookupError:
    download('wordnet')
    download('omw-1.4')
    download('punkt')

app = Flask(__name__)

def normalize(text):
    # Lowercase, remove punctuation, and strip
    return ''.join([c for c in text.lower() if c not in string.punctuation]).strip()

def get_synsets(text):
    tokens = word_tokenize(text)
    synsets = []
    for token in tokens:
        synsets.extend(wn.synsets(token))
    return synsets

def semantic_similarity(a, b):
    # Get synsets for both
    synsets_a = get_synsets(a)
    synsets_b = get_synsets(b)
    if not synsets_a or not synsets_b:
        return 0.0
    # Compute max path similarity between any pair
    max_sim = 0.0
    for syn_a in synsets_a:
        for syn_b in synsets_b:
            sim = syn_a.path_similarity(syn_b)
            if sim and sim > max_sim:
                max_sim = sim
    return max_sim if max_sim else 0.0

def compute_confidence(sim):
    # Path similarity is 0-1, scale to 0-100
    return int(round(sim * 100))

@app.route('/semantic-match', methods=['POST'])
def semantic_match():
    data = request.get_json()
    question = data.get('question', '')
    correct_answers = data.get('correct_answers', [])
    responses = data.get('responses', [])
    results = []
    for resp in responses:
        best_score = 0.0
        best_match = None
        for ca in correct_answers:
            sim = semantic_similarity(resp, ca)
            if sim > best_score:
                best_score = sim
                best_match = ca
        confidence = compute_confidence(best_score)
        results.append({
            'response': resp,
            'best_match': best_match if confidence > 0 else None,
            'confidence': confidence
        })
    return jsonify({'results': results})

if __name__ == '__main__':
    app.run(port=5005, debug=True) 