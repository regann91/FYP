from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
from transformers import pipeline

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load the BERT model you just installed
print("Initializing BERT-Tiny AI...")
classifier = pipeline("text-classification", model="mrm8488/bert-tiny-finetuned-sms-spam-detection")

class CommentRequest(BaseModel):
    comments: List[str]

@app.post("/analyze")
async def analyze(request: CommentRequest):
    # Process comments through the AI
    predictions = classifier([c[:512] for c in request.comments])
    
    results = []
    for pred in predictions:
        # BERT-Tiny uses 'label_1' for spam and 'label_0' for ham
        is_spam = pred['label'].lower() == 'label_1'
        score = pred['score'] if is_spam else (1 - pred['score'])
        
        results.append({
            "label": "SCAM" if is_spam else "HAM",
            "score": score
        })
    
    print(f"AI Analysis Complete: Found {sum(1 for r in results if r['label'] == 'SCAM')} potential scams.")
    return results

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)