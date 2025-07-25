# 👥 Grader Access Guide - Multi-User Grading System

## 🚀 **How Graders Access the System**

### **Method 1: Direct Grading Portal (Recommended)**

1. **Start the server:**
   ```bash
   cd C:\Users\liqui\MEGASheep
   node server.js
   ```

2. **Access the grading portal:**
   - Open browser and go to: `http://localhost:3001/grading`
   - This is the dedicated grading access page
   - Shows connection status and access options

3. **Choose your interface:**
   - **Main Grading Interface**: Full-featured with all questions
   - **Test Collaboration**: Simple test to practice multi-user sync

### **Method 2: Through Main Application**

1. **Access main app:**
   - Go to: `http://localhost:3001`
   - Click "Create Game" or "Join Game"
   - As host, you'll see grading buttons in the dashboard

2. **Access grading:**
   - **Single-user**: Click "📝 Grading Interface" button
   - **Multi-user**: Click "👥 Multi-User Grading" button

### **Method 3: Multiple Browser Tabs**

1. **Open multiple tabs** with the same URL
2. **Each tab represents a different grader**
3. **Select the same question** in each tab
4. **Automatic collaboration** begins immediately

## 🎯 **Step-by-Step Access Instructions**

### **For First-Time Graders:**

1. **Get the server running:**
   ```bash
   cd C:\Users\liqui\MEGASheep
   node server.js
   ```

2. **Open the grading portal:**
   - Navigate to `http://localhost:3001/grading`
   - Verify connection status shows "Connected to server"

3. **Choose your interface:**
   - **New to the system?** → Start with "Test Collaboration"
   - **Ready for production?** → Use "Main Grading Interface"

4. **Join a grading session:**
   - Select a question to grade
   - Automatically join the grading room
   - See real-time grader count

### **For Multiple Graders:**

1. **Coordinator sets up:**
   - Starts server
   - Shares the URL: `http://localhost:3001/grading`
   - Decides which question to grade

2. **Graders join:**
   - Each grader opens the URL in their browser
   - Selects the same question
   - Automatically joins the same grading room

3. **Collaboration begins:**
   - All changes sync in real-time
   - Visual feedback for remote changes
   - Grader count updates automatically

## 📱 **Access URLs Summary**

| Purpose | URL | Description |
|---------|-----|-------------|
| **Grading Portal** | `http://localhost:3001/grading` | Main access point for graders |
| **Test Interface** | `http://localhost:3001/test-grading` | Practice multi-user collaboration |
| **Main App** | `http://localhost:3001` | Full application with grading access |
| **Display Mode** | `http://localhost:3001/display` | For game display/projection |

## 🔧 **Technical Access Details**

### **Server Requirements:**
- Node.js server running on port 3001
- Socket.IO for real-time communication
- All graders must access the same server instance

### **Browser Requirements:**
- Modern browser with WebSocket support
- JavaScript enabled
- Stable internet connection

### **Network Access:**
- **Local access**: `http://localhost:3001/grading`
- **LAN access**: `http://[server-ip]:3001/grading`
- **Internet access**: Requires proper server configuration

## 🎮 **Real-World Usage Scenarios**

### **Scenario 1: Live Game Grading**
```
1. Game starts with 50+ players
2. 3 graders open http://localhost:3001/grading
3. All select "Question 1" to join same room
4. Answers stream in as players submit
5. Graders work simultaneously categorizing
6. Real-time sync prevents duplicate work
```

### **Scenario 2: Training Session**
```
1. Experienced grader + 2 trainees
2. All access http://localhost:3001/grading
3. Select same question for training
4. Experienced grader demonstrates
5. Trainees observe and practice
6. Real-time feedback and learning
```

### **Scenario 3: Post-Game Review**
```
1. Game ends, all answers collected
2. Team of 4 graders reviews together
3. Access grading interface simultaneously
4. Collaborative decisions on edge cases
5. Consistent results across all graders
```

## 🚨 **Troubleshooting Access Issues**

### **Can't Connect to Server:**
- Verify server is running: `node server.js`
- Check port 3001 is available
- Try `http://localhost:3001` first

### **Graders Not Syncing:**
- Ensure all graders select same question
- Check browser console for errors
- Verify Socket.IO connection status

### **Performance Issues:**
- Limit to 5-10 concurrent graders
- Close unused browser tabs
- Check server resources

## 💡 **Pro Tips for Graders**

### **Efficient Collaboration:**
1. **Coordinate roles** - decide who handles which answer types
2. **Use confidence scores** - focus on low-confidence answers first
3. **Watch for green flashes** - indicates other graders' changes
4. **Right-click for speed** - quickly mark answers as wrong

### **Best Practices:**
1. **Stay connected** - ensure stable internet
2. **Communicate** - use visual feedback to avoid conflicts
3. **Save regularly** - export results periodically
4. **Monitor activity** - watch grader count and status

## 🎉 **Getting Started Checklist**

- [ ] Server running on port 3001
- [ ] Access `http://localhost:3001/grading`
- [ ] Verify connection status is green
- [ ] Choose grading interface
- [ ] Select question to grade
- [ ] Confirm grader count > 1 (if collaborating)
- [ ] Start categorizing answers
- [ ] Watch for real-time sync

## 🔗 **Quick Access Links**

- **Grading Portal**: `http://localhost:3001/grading`
- **Test Interface**: `http://localhost:3001/test-grading`
- **Main App**: `http://localhost:3001`
- **Documentation**: `GRADING_COLLABORATION_GUIDE.md`

---

**Ready to start collaborative grading!** 🚀

The multi-user grading system is designed to be simple to access while providing powerful collaborative features. Just open the grading portal and start working together in real-time! 