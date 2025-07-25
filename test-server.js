const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('Test server is working!');
});

const PORT = 3002;
app.listen(PORT, () => {
  console.log(`Test server running on port ${PORT}`);
}); 