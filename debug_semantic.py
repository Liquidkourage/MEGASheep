import spacy
import numpy as np

# Load spaCy model
try:
    nlp = spacy.load("en_core_web_md")
    print("✅ spaCy model loaded successfully")
except OSError:
    print("❌ Error: en_core_web_md model not found")
    exit(1)

# Chinese zodiac synonyms mapping (same as in semantic_matcher.py)
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

def normalize(text):
    return text.lower().strip()

def get_zodiac_synonym_boost(text1, text2):
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

def test_similarity(text1, text2):
    """Test enhanced similarity between two texts"""
    doc1 = nlp(normalize(text1))
    doc2 = nlp(normalize(text2))
    
    if not doc1.has_vector or not doc2.has_vector:
        return 0.0
    
    # Compute base cosine similarity
    base_similarity = doc1.similarity(doc2)
    
    # Apply Chinese zodiac synonym boost
    zodiac_boost = get_zodiac_synonym_boost(text1, text2)
    
    # Combine base similarity with zodiac boost
    enhanced_similarity = min(1.0, base_similarity + zodiac_boost)
    
    return float(enhanced_similarity)

# Test the problematic matches
print("\n🔍 Testing semantic similarities:")
print("=" * 50)

# Test chicken vs rooster
chicken_rooster = test_similarity("chicken", "rooster")
print(f"chicken ↔ rooster: {chicken_rooster:.3f} ({chicken_rooster*100:.1f}%)")

# Test chicken vs pig
chicken_pig = test_similarity("chicken", "pig")
print(f"chicken ↔ pig: {chicken_pig:.3f} ({chicken_pig*100:.1f}%)")

# Test chicken vs other animals
chicken_rat = test_similarity("chicken", "rat")
print(f"chicken ↔ rat: {chicken_rat:.3f} ({chicken_rat*100:.1f}%)")

chicken_ox = test_similarity("chicken", "ox")
print(f"chicken ↔ ox: {chicken_ox:.3f} ({chicken_ox*100:.1f}%)")

# Test all correct answers against chicken
correct_answers = ["rat", "ox", "tiger", "rabbit", "dragon", "snake", "horse", "goat", "monkey", "rooster", "dog", "pig"]

print(f"\n🔍 Chicken vs all correct answers:")
print("-" * 40)
for answer in correct_answers:
    sim = test_similarity("chicken", answer)
    print(f"chicken ↔ {answer}: {sim:.3f} ({sim*100:.1f}%)")

# Find the best match
best_match = max(correct_answers, key=lambda x: test_similarity("chicken", x))
best_sim = test_similarity("chicken", best_match)
print(f"\n🏆 Best match for 'chicken': {best_match} ({best_sim*100:.1f}%)")

# Test some other problematic matches
print(f"\n🔍 Testing other matches:")
print("-" * 30)
print(f"bull ↔ ox: {test_similarity('bull', 'ox'):.3f} ({test_similarity('bull', 'ox')*100:.1f}%)")
print(f"mouse ↔ rat: {test_similarity('mouse', 'rat'):.3f} ({test_similarity('mouse', 'rat')*100:.1f}%)")
print(f"sheep ↔ goat: {test_similarity('sheep', 'goat'):.3f} ({test_similarity('sheep', 'goat')*100:.1f}%)") 