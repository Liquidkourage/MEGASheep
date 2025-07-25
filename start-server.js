try {
  console.log('Starting MEGASheep server...');
  require('./server.js');
  console.log('Server started successfully!');
} catch (error) {
  console.error('Error starting server:', error);
  process.exit(1);
} 1);
} 