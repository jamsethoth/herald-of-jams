namespace HeraldOfJams.Launcher.Configuration;

public static class SetupValidator
{
    private static bool IsUnsafe(string value) =>
        value.IndexOfAny(['\r', '\n', '\0', '"']) >= 0;

    public static IReadOnlyList<ValidationIssue> Validate(SetupInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var issues = new List<ValidationIssue>();
        ValidateRequiredText(input.DiscordToken, nameof(input.DiscordToken), issues);
        ValidateDecimalId(input.ApplicationId, nameof(input.ApplicationId), issues);
        ValidateDecimalId(input.GuildId, nameof(input.GuildId), issues);
        ValidateRequiredText(input.AdminPassword, nameof(input.AdminPassword), issues);
        if (input.AdminPort is < 1 or > 65535)
        {
            issues.Add(new ValidationIssue(nameof(input.AdminPort), "AdminPort must be between 1 and 65535."));
        }
        return issues;
    }

    private static void ValidateRequiredText(string value, string field, ICollection<ValidationIssue> issues)
    {
        if (string.IsNullOrEmpty(value))
        {
            issues.Add(new ValidationIssue(field, $"{field} is required."));
        }
        else if (IsUnsafe(value))
        {
            issues.Add(new ValidationIssue(field, $"{field} contains unsupported characters."));
        }
    }

    private static void ValidateDecimalId(string value, string field, ICollection<ValidationIssue> issues)
    {
        if (string.IsNullOrEmpty(value) || value.Any(character => character is < '0' or > '9'))
        {
            issues.Add(new ValidationIssue(field, $"{field} must contain decimal digits only."));
        }
        else if (IsUnsafe(value))
        {
            issues.Add(new ValidationIssue(field, $"{field} contains unsupported characters."));
        }
    }
}
