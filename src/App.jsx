import React, { useState, useEffect, useRef } from 'react';
import { Play, Square, Terminal, CheckCircle, Eye, EyeOff, LayoutDashboard, Settings2, Sun, Moon } from 'lucide-react';

function App() {
    const [status, setStatus] = useState('IDLE');
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(false);
    const [headless, setHeadless] = useState(true); // Default to 'Off screen'
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [startRow, setStartRow] = useState(2); // Default to row 2 (skip header)
    const [progress, setProgress] = useState({ current: 0, total: 0, percent: 0 });
    const [theme, setTheme] = useState(() => localStorage.getItem('rpa-theme') || 'muji');
    const [logEndRef] = [useRef(null)];

    // Apply theme to <html> element
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('rpa-theme', theme);
    }, [theme]);

    const toggleTheme = () => setTheme(prev => prev === 'muji' ? 'neon' : 'muji');

    const fetchStatus = async () => {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            setStatus(data.status);
            setLogs(data.logs);
            if (data.progress) setProgress(data.progress);
        } catch (err) {
            console.error('Failed to fetch status');
        }
    };

    useEffect(() => {
        fetchStatus();
        const interval = setInterval(fetchStatus, 2000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    const handleLogin = async () => {
        setLoading(true);
        try {
            await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ headless, username, password, startRow: Number(startRow) })
            });
            fetchStatus();
        } catch (err) {
            alert('Failed to start login');
        }
        setLoading(false);
    };


    const handleStop = async () => {
        try {
            await fetch('/api/stop', { method: 'POST' });
            fetchStatus();
        } catch (err) {
            alert('Failed to stop robot');
        }
    };

    const isRunning = status === 'RUNNING';

    return (
        <div className="dashboard">
            {/* Header */}
            <div className="header">
                <h1>Create a promotion: <span>Buy A get A free</span></h1>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <button className="theme-toggle-btn" onClick={toggleTheme} title={theme === 'muji' ? 'Switch to Neon' : 'Switch to MUJI'}>
                        {theme === 'muji' ? <Moon size={16} /> : <Sun size={16} />}
                    </button>
                    <div className={`status-badge status-${status.toLowerCase()}`}>
                        {status}
                    </div>
                </div>
            </div>

            {/* Control Card */}
            <div className="card">
                <h2><LayoutDashboard size={16} /> Dashboard & Config</h2>


                {/* Task Configuration */}
                <div className="mode-section" style={{ marginTop: '1.5rem' }}>
                    <div className="mode-label"><Settings2 size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> Task Configuration</div>
                    
                    {/* Browser Mode Toggle */}
                    <div className="mode-toggle" style={{ marginTop: '0.5rem' }}>
                        <button
                            className={`mode-option ${headless ? 'active' : ''}`}
                            onClick={() => setHeadless(true)}
                            disabled={isRunning}
                        >
                            <EyeOff size={14} />
                            Off screen (ซ่อนหน้าต่าง)
                        </button>
                        <button
                            className={`mode-option ${!headless ? 'active' : ''}`}
                            onClick={() => setHeadless(false)}
                            disabled={isRunning}
                        >
                            <Eye size={14} />
                            On screen (เช็คความถูกต้อง)
                        </button>
                    </div>

                    {/* Start Row Setting */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1.25rem' }}>
                        <label style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>🚀 Start Row</label>
                        <input
                            type="number"
                            min="2"
                            placeholder="2"
                            value={startRow}
                            onChange={(e) => setStartRow(e.target.value)}
                            disabled={isRunning}
                            style={{ ...inputStyle, width: '100px', textAlign: 'center' }}
                        />
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-light)' }}>ข้ามแถวก่อนหน้า (Header = Row 1)</span>
                    </div>
                </div>

                {/* Progress Bar (Visual) */}
                {progress.total > 0 && (
                    <div className="progress-section">
                        <div className="progress-header">
                            <div className="progress-label">
                                <Terminal size={14} /> Processing Progress
                            </div>
                            <div className="progress-percent">{progress.percent}%</div>
                        </div>
                        <div className="progress-track">
                            <div
                                className={`progress-fill ${progress.percent === 100 ? 'complete' : ''}`}
                                style={{ width: `${progress.percent}%` }}
                            ></div>
                        </div>
                        <div className="progress-stats" style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>⏱️ Duration: {progress.duration}</span>
                            <span>Processed {progress.current} of {progress.total} items</span>
                        </div>
                    </div>
                )}

                {/* Action Buttons */}
                <div className="controls" style={{ marginTop: '1.5rem' }}>
                    <button
                        className="btn-primary"
                        onClick={handleLogin}
                        disabled={isRunning || loading}
                    >
                        <Play size={16} />
                        {isRunning ? 'กำลังทำงาน...' : 'เริ่ม Login และนำทาง'}
                    </button>

                    <button
                        className="btn-danger"
                        onClick={handleStop}
                    >
                        <Square size={16} />
                        หยุด/ปิด Browser
                    </button>
                </div>
            </div>

            {/* Logs */}
            <div className="logs-card">
                <h3><Terminal size={16} /> System Log</h3>
                <div className="logs-container">
                    {logs.length === 0 && (
                        <div className="log-entry">Ready to start...</div>
                    )}
                    {logs.map((log, i) => (
                        <div
                            key={i}
                            className={`log-entry ${log.includes('✅') || log.includes('Success') ? 'highlight' : ''}`}
                        >
                            {log}
                        </div>
                    ))}
                    <div ref={logEndRef} />
                </div>
            </div>

            {/* Footer */}
            <div className="footer">
                RPA Promotion &middot; Dashboard v1.1
            </div>
        </div>
    );
}

const inputStyle = {
    width: '100%',
    padding: '0.6rem 0.8rem',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--card-border)',
    background: 'var(--bg-warm)',
    color: 'var(--text)',
    fontSize: '0.85rem',
    fontFamily: 'inherit'
};

export default App;
