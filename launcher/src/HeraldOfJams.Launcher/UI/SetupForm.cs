using HeraldOfJams.Launcher.Configuration;

namespace HeraldOfJams.Launcher.UI;

public sealed class SetupForm : Form
{
    private readonly TextBox token = new() { UseSystemPasswordChar = true, Width = 320 };
    private readonly TextBox applicationId = new() { Width = 320 };
    private readonly TextBox guildId = new() { Width = 320 };
    private readonly TextBox password = new() { UseSystemPasswordChar = true, Width = 320 };
    private readonly NumericUpDown port = new() { Minimum = 1, Maximum = 65535, Value = 3000, Width = 100 };
    private readonly Label error = new() { AutoSize = true, ForeColor = Color.Firebrick };

    public SetupForm(StoredConfiguration? existing = null)
    {
        Text = existing is null ? "Set up Herald of Jams" : "Configure Herald of Jams";
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false;
        MinimizeBox = false;
        if (existing is not null)
        {
            applicationId.Text = existing.ApplicationId;
            guildId.Text = existing.GuildId;
            port.Value = existing.AdminPort;
            token.PlaceholderText = "Leave blank to keep the current token";
            password.PlaceholderText = "Leave blank to keep the current password";
        }
        var table = new TableLayoutPanel { AutoSize = true, Padding = new Padding(16), ColumnCount = 2 };
        AddRow(table, "Discord token", token);
        AddRow(table, "Application ID", applicationId);
        AddRow(table, "Guild ID", guildId);
        AddRow(table, "Admin password", password);
        AddRow(table, "Admin port", port);
        table.Controls.Add(error, 0, 5);
        table.SetColumnSpan(error, 2);
        var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft };
        var save = new Button { Text = "Save", AutoSize = true };
        var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel };
        save.Click += (_, _) => Save(existing is not null);
        buttons.Controls.Add(save);
        buttons.Controls.Add(cancel);
        table.Controls.Add(buttons, 0, 6);
        table.SetColumnSpan(buttons, 2);
        Controls.Add(table);
        AcceptButton = save;
        CancelButton = cancel;
    }

    public SetupInput? Result { get; private set; }

    private void Save(bool editing)
    {
        var value = new SetupInput(token.Text, applicationId.Text, guildId.Text, password.Text, decimal.ToInt32(port.Value));
        var issues = SetupValidator.Validate(value).Where(issue => !(editing && issue.Field is "DiscordToken" or "AdminPassword" && string.IsNullOrEmpty(issue.Field == "DiscordToken" ? value.DiscordToken : value.AdminPassword))).ToArray();
        if (issues.Length > 0) { error.Text = string.Join(Environment.NewLine, issues.Select(issue => issue.Message)); return; }
        Result = value;
        DialogResult = DialogResult.OK;
        Close();
    }

    private static void AddRow(TableLayoutPanel table, string label, Control control)
    {
        var row = table.RowCount++;
        table.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left }, 0, row);
        table.Controls.Add(control, 1, row);
    }
}
