from services.rag import *

text = """
Newton's First Law states that an object remains at rest
or in uniform motion unless acted upon by an external force.

Newton's Second Law states:
Force = Mass × Acceleration.

Einstein developed the Theory of Relativity.
"""

chunks = chunk_text(text)
for i, chunk in enumerate(chunks):
    print(f"\nChunk {i+1}:")
    print(chunk)

print("Chunks:", len(chunks))

build_index(chunks)

results = search("Who developed relativity?")

print(results)